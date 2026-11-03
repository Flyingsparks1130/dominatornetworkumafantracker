import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { execFileSync } from "node:child_process";

const DATA_DIR = path.join("data", "chronogenesis");
const ARCHIVE_DIR = path.join(DATA_DIR, "archive");
const CONFIG_DIR = path.join(ARCHIVE_DIR, "config");
const INDEX_PATH = path.join("index.html");
const TIME_ZONE = "Asia/Bangkok";
const MONTH_KEY_PATTERN = /^(\d{4})-(\d{2})$/;

fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
fs.mkdirSync(CONFIG_DIR, { recursive: true });

function pad2(value) {
  return String(value).padStart(2, "0");
}

function getBangkokDateParts(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);

  return {
    year: Number(parts.find((part) => part.type === "year")?.value),
    month: Number(parts.find((part) => part.type === "month")?.value),
    day: Number(parts.find((part) => part.type === "day")?.value),
  };
}

function getPreviousBangkokMonth(now = new Date()) {
  const current = getBangkokDateParts(now);
  const previous = new Date(Date.UTC(current.year, current.month - 2, 1));
  const year = previous.getUTCFullYear();
  const month = previous.getUTCMonth() + 1;

  return { year, month, key: `${year}-${pad2(month)}` };
}

function parseMonthKey(monthKey) {
  const match = String(monthKey || "").match(MONTH_KEY_PATTERN);
  if (!match) {
    throw new Error(`Invalid month "${monthKey}". Expected YYYY-MM.`);
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) {
    throw new Error(`Invalid month "${monthKey}". Month must be between 01 and 12.`);
  }

  return { year, month, key: `${year}-${pad2(month)}` };
}

function parseArgs(argv) {
  const options = {
    monthKey: null,
    sourceRef: null,
    allowIncomplete: false,
  };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];

    if (arg === "--allow-incomplete") {
      options.allowIncomplete = true;
      continue;
    }

    if (arg === "--month" || arg === "--source-ref") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`Missing value for ${arg}`);
      }
      index++;
      if (arg === "--month") options.monthKey = value;
      if (arg === "--source-ref") options.sourceRef = value;
      continue;
    }

    if (arg.startsWith("--month=")) {
      options.monthKey = arg.slice("--month=".length);
      continue;
    }

    if (arg.startsWith("--source-ref=")) {
      options.sourceRef = arg.slice("--source-ref=".length);
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (options.monthKey) parseMonthKey(options.monthKey);

  if (options.sourceRef) {
    if (!/^[0-9A-Za-z][0-9A-Za-z._\/-]*$/.test(options.sourceRef)) {
      throw new Error(`Invalid Git source ref: ${options.sourceRef}`);
    }
    if (!options.monthKey) {
      throw new Error("--source-ref requires an explicit --month");
    }
  }

  return options;
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n");
}

function writeJsonIfChanged(filePath, data) {
  const next = JSON.stringify(data, null, 2) + "\n";
  const current = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : null;
  if (current === next) return false;

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, next);
  return true;
}

function verifySourceRef(sourceRef) {
  if (!sourceRef) return;
  execFileSync("git", ["rev-parse", "--verify", `${sourceRef}^{commit}`], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function listSourceFiles(sourceRef) {
  if (!sourceRef) {
    return fs
      .readdirSync(DATA_DIR)
      .filter((fileName) => {
        const fullPath = path.join(DATA_DIR, fileName);
        return fs.statSync(fullPath).isFile() && /^\d+\.json$/.test(fileName);
      })
      .sort();
  }

  const dataPath = DATA_DIR.split(path.sep).join(path.posix.sep);
  const output = execFileSync(
    "git",
    ["ls-tree", "-r", "--name-only", sourceRef, "--", dataPath],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
  );

  return output
    .split(/\r?\n/)
    .filter((repoPath) => new RegExp(`^${dataPath}/\\d+\\.json$`).test(repoPath))
    .map((repoPath) => path.posix.basename(repoPath))
    .sort();
}

function readSourceJson(fileName, sourceRef) {
  if (!sourceRef) {
    return readJson(path.join(DATA_DIR, fileName));
  }

  const repoPath = path.posix.join("data", "chronogenesis", fileName);
  const source = execFileSync("git", ["show", `${sourceRef}:${repoPath}`], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 50 * 1024 * 1024,
  });

  return JSON.parse(source);
}

function extractConstValue(source, name) {
  const match = new RegExp(`\\bconst\\s+${name}\\s*=\\s*`).exec(source);
  if (!match) return null;

  const start = match.index + match[0].length;
  const end = source.indexOf(";", start);
  if (end < 0) throw new Error(`Could not find the end of const ${name}`);

  const expression = source.slice(start, end).trim();
  return vm.runInNewContext(`(${expression})`, Object.create(null), { timeout: 1000 });
}

function readFrontendConfigFromIndex(monthKey) {
  if (!fs.existsSync(INDEX_PATH)) return null;

  const source = fs.readFileSync(INDEX_PATH, "utf8");
  const clubs = extractConstValue(source, "CLUBS");
  const rankingConfig = extractConstValue(source, "RANKING_CONFIG");
  const clubTierOrder = extractConstValue(source, "CLUB_TIER_ORDER");
  const maxMembers = extractConstValue(source, "MAX_MEMBERS");
  const rankIconPath = extractConstValue(source, "RANK_ICON_PATH");
  const tierColors = extractConstValue(source, "TIER_COLORS");

  if (!Array.isArray(clubs) || !clubs.length) return null;

  return {
    schema: 1,
    month: monthKey,
    source: "index.html-fallback",
    sourceFile: INDEX_PATH,
    capturedAt: new Date().toISOString(),
    timeZone: TIME_ZONE,
    clubs,
    rankingConfig: Array.isArray(rankingConfig) ? rankingConfig : [],
    clubTierOrder: Array.isArray(clubTierOrder) ? clubTierOrder : [],
    maxMembers: Number(maxMembers || 0),
    rankIconPath: typeof rankIconPath === "string" ? rankIconPath : "./data/rank_pics/",
    tierColors: tierColors && typeof tierColors === "object" ? tierColors : {},
    clubConfigById: Object.fromEntries(clubs.map((club) => [String(club.id), club])),
  };
}

function readFrontendConfigForMonth(monthKey) {
  const configPath = path.join(CONFIG_DIR, `${monthKey}.json`);
  if (fs.existsSync(configPath)) {
    const config = readJson(configPath);
    return {
      ...config,
      sourceFile: path.posix.join(
        "data",
        "chronogenesis",
        "archive",
        "config",
        `${monthKey}.json`
      ),
    };
  }

  const fallback = readFrontendConfigFromIndex(monthKey);
  if (fallback) {
    writeJson(configPath, fallback);
    console.log(`created fallback config snapshot: ${configPath}`);
  } else {
    console.log(`warning: no frontend config snapshot found for ${monthKey}`);
  }

  return fallback;
}

function getClubRoot(json) {
  return Array.isArray(json?.club) ? json.club[0] : null;
}

function getClubIdFromJson(json, fallbackClubId) {
  const clubRoot = getClubRoot(json);
  return String(clubRoot?.circle_id ?? clubRoot?.id ?? clubRoot?.club_id ?? fallbackClubId);
}

function getMaxActualDateFromRows(rows, dim) {
  if (!Array.isArray(rows)) return 0;

  return rows.reduce((maxDay, row) => {
    const actualDate = Number(row?.actual_date);
    if (!Number.isFinite(actualDate)) return maxDay;
    if (actualDate < 1 || actualDate > dim) return maxDay;
    return Math.max(maxDay, actualDate);
  }, 0);
}

function hasActualDate(rows, actualDate) {
  if (!Array.isArray(rows)) return false;
  return rows.some((row) => Number(row?.actual_date) === Number(actualDate));
}

function getMaxFriendHistoryActualDate(json, dim) {
  return getMaxActualDateFromRows(json?.club_friend_history, dim);
}

function getMaxClubDailyHistoryActualDate(json, dim) {
  return getMaxActualDateFromRows(json?.club_daily_history, dim);
}

function getActiveMemberCoverage(json, dim) {
  const clubRoot = getClubRoot(json);
  if (!clubRoot) {
    return {
      sharedActualDate: 0,
      activeProfileCount: 0,
      activeProfilesWithFinalDay: 0,
      missingFinalDayViewerIds: [],
      rosterCoverageComplete: false,
    };
  }

  const friendProfiles = Array.isArray(json?.club_friend_profile) ? json.club_friend_profile : [];
  const friendHistory = Array.isArray(json?.club_friend_history) ? json.club_friend_history : [];
  const activeRosterIds = new Set(
    Array.isArray(clubRoot?.circle_user_array)
      ? clubRoot.circle_user_array.map((id) => String(id))
      : []
  );

  const historyDaysByViewerId = {};
  for (const row of friendHistory) {
    const viewerId = row?.friend_viewer_id;
    const actualDate = Number(row?.actual_date);

    if (viewerId == null) continue;
    if (!Number.isFinite(actualDate)) continue;
    if (actualDate < 1 || actualDate > dim) continue;

    const key = String(viewerId);
    if (!historyDaysByViewerId[key]) historyDaysByViewerId[key] = new Set();
    historyDaysByViewerId[key].add(actualDate);
  }

  const activeProfileViewerIds = friendProfiles
    .map((profile) => String(profile?.friend_viewer_id ?? ""))
    .filter((viewerId) => viewerId && activeRosterIds.has(viewerId));

  let sharedMax = 0;
  if (activeProfileViewerIds.length) {
    for (let day = 1; day <= dim; day++) {
      const everyoneHasDay = activeProfileViewerIds.every((viewerId) =>
        historyDaysByViewerId[viewerId]?.has(day)
      );

      if (everyoneHasDay) sharedMax = day;
    }
  }

  const missingFinalDayViewerIds = activeProfileViewerIds.filter(
    (viewerId) => !historyDaysByViewerId[viewerId]?.has(dim)
  );

  return {
    sharedActualDate: sharedMax,
    activeProfileCount: activeProfileViewerIds.length,
    activeProfilesWithFinalDay:
      activeProfileViewerIds.length - missingFinalDayViewerIds.length,
    missingFinalDayViewerIds,
    rosterCoverageComplete:
      activeProfileViewerIds.length > 0 && missingFinalDayViewerIds.length === 0,
  };
}

function getSharedActualDate(json, dim) {
  return getActiveMemberCoverage(json, dim).sharedActualDate;
}

function archiveIsAlreadyLocked(archivePath, monthKey, dim) {
  if (!fs.existsSync(archivePath)) return false;

  try {
    const archived = readJson(archivePath);

    const archiveMeta = archived?._archive || {};
    const archiveClubDailyMax = Number(
      archiveMeta.maxClubDailyHistoryActualDate ??
      getMaxClubDailyHistoryActualDate(archived, dim)
    );

    const archiveFriendMax = Number(
      archiveMeta.maxFriendHistoryActualDate ??
      archiveMeta.maxActualDate ??
      getMaxFriendHistoryActualDate(archived, dim)
    );

    const archiveShared = Number(
      archiveMeta.completedActualDate ?? getSharedActualDate(archived, dim)
    );

    const hasFinalClubDailyRow = hasActualDate(archived?.club_daily_history, dim);

    const isLocked =
      archiveMeta.source === "chronogenesis" &&
      archiveMeta.month === monthKey &&
      archiveMeta.locked === true &&
      archiveFriendMax >= dim &&
      archiveClubDailyMax >= dim &&
      hasFinalClubDailyRow;

    if (!isLocked) {
      console.log(
        `  existing archive is incomplete; will overwrite. ` +
        `shared=${archiveShared}, friendMax=${archiveFriendMax}, clubDailyMax=${archiveClubDailyMax}, hasDay${dim}ClubDaily=${hasFinalClubDailyRow}`
      );
    }

    return isLocked;
  } catch {
    return false;
  }
}

function getClubConfig(frontendConfig, clubId) {
  const clubKey = String(clubId);
  const byId =
    frontendConfig?.clubConfigById && typeof frontendConfig.clubConfigById === "object"
      ? frontendConfig.clubConfigById
      : null;

  if (byId?.[clubKey]) return byId[clubKey];

  const clubs = Array.isArray(frontendConfig?.clubs) ? frontendConfig.clubs : [];
  return clubs.find((club) => String(club.id) === clubKey) || null;
}

function updateArchiveManifest() {
  const files = fs
    .readdirSync(ARCHIVE_DIR)
    .filter((file) => /^\d+_\d{4}-\d{2}\.json$/.test(file))
    .sort();

  const monthMap = new Map();
  const clubMap = new Map();

  for (const file of files) {
    const match = file.match(/^(\d+)_(\d{4}-\d{2})\.json$/);
    if (!match) continue;

    const [, clubId, monthKey] = match;

    if (!monthMap.has(monthKey)) {
      monthMap.set(monthKey, { key: monthKey, label: monthKey, clubs: [] });
    }

    if (!clubMap.has(clubId)) {
      clubMap.set(clubId, []);
    }

    monthMap.get(monthKey).clubs.push(clubId);
    clubMap.get(clubId).push(monthKey);
  }

  const manifestPath = path.join(ARCHIVE_DIR, "manifest.json");
  const indexPath = path.join(ARCHIVE_DIR, "index.json");
  const existingManifest = fs.existsSync(manifestPath) ? readJson(manifestPath) : null;
  const manifestCore = {
    files,
    months: [...monthMap.values()].sort((a, b) => b.key.localeCompare(a.key)),
    clubs: Object.fromEntries(
      [...clubMap.entries()].map(([clubId, months]) => [clubId, months.sort()])
    ),
    configFiles: fs.existsSync(CONFIG_DIR)
      ? fs.readdirSync(CONFIG_DIR).filter((file) => /^\d{4}-\d{2}\.json$/.test(file)).sort()
      : [],
  };
  const existingCore = existingManifest
    ? {
        files: existingManifest.files,
        months: existingManifest.months,
        clubs: existingManifest.clubs,
        configFiles: existingManifest.configFiles,
      }
    : null;
  const archiveSetChanged =
    !existingCore || JSON.stringify(existingCore) !== JSON.stringify(manifestCore);
  const manifest = {
    generatedAt:
      archiveSetChanged || !existingManifest?.generatedAt
        ? new Date().toISOString()
        : existingManifest.generatedAt,
    ...manifestCore,
  };

  writeJsonIfChanged(manifestPath, manifest);
  writeJsonIfChanged(indexPath, manifest);
}

function archiveOneLiveFile(fileName, targetMonth, frontendConfig, sourceRef) {
  const fallbackClubId = path.basename(fileName, ".json");
  const json = readSourceJson(fileName, sourceRef);
  const clubId = getClubIdFromJson(json, fallbackClubId);
  if (clubId !== fallbackClubId) {
    throw new Error(
      `Club id mismatch in ${fileName}: filename=${fallbackClubId}, payload=${clubId}`
    );
  }

  const dim = daysInMonth(targetMonth.year, targetMonth.month);

  const memberCoverage = getActiveMemberCoverage(json, dim);
  const sharedActualDate = memberCoverage.sharedActualDate;
  const maxFriendHistoryActualDate = getMaxFriendHistoryActualDate(json, dim);
  const maxClubDailyHistoryActualDate = getMaxClubDailyHistoryActualDate(json, dim);
  const hasFinalClubDailyRow = hasActualDate(json?.club_daily_history, dim);

  const archiveFileName = `${clubId}_${targetMonth.key}.json`;
  const archivePath = path.join(ARCHIVE_DIR, archiveFileName);

  console.log(
    `${clubId}: targetMonth=${targetMonth.key}, ` +
    `sharedActualDate=${sharedActualDate}, ` +
    `friendMax=${maxFriendHistoryActualDate}, ` +
    `clubDailyMax=${maxClubDailyHistoryActualDate}, ` +
    `finalDayRoster=${memberCoverage.activeProfilesWithFinalDay}/${memberCoverage.activeProfileCount}, ` +
    `dim=${dim}`
  );

  if (archiveIsAlreadyLocked(archivePath, targetMonth.key, dim)) {
    console.log(`  locked already: ${archivePath}`);
    return { clubId, status: "locked", archivePath };
  }

  if (maxFriendHistoryActualDate < dim) {
    console.log("  skip: club_friend_history is not complete yet");
    return {
      clubId,
      status: "incomplete",
      reason: `club_friend_history max day is ${maxFriendHistoryActualDate}; expected ${dim}`,
    };
  }

  if (maxClubDailyHistoryActualDate < dim || !hasFinalClubDailyRow) {
    console.log(
      `  skip: club_daily_history is not complete yet ` +
      `(clubDailyMax=${maxClubDailyHistoryActualDate}, hasDay${dim}=${hasFinalClubDailyRow})`
    );
    return {
      clubId,
      status: "incomplete",
      reason:
        `club_daily_history max day is ${maxClubDailyHistoryActualDate}; ` +
        `has day ${dim}: ${hasFinalClubDailyRow}`,
    };
  }

  if (!memberCoverage.rosterCoverageComplete) {
    console.log(
      `  warning: ${memberCoverage.missingFinalDayViewerIds.length} current roster ` +
      `profile(s) do not have day ${dim}; archiving the completed club payload anyway`
    );
  }

  const archivedJson = {
    ...json,
    _archive: {
      source: "chronogenesis",
      clubId,
      month: targetMonth.key,
      year: targetMonth.year,
      monthNumber: targetMonth.month,

      completedActualDate: sharedActualDate,
      maxActualDate: maxFriendHistoryActualDate,
      maxFriendHistoryActualDate,
      maxClubDailyHistoryActualDate,
      memberCoverage,

      hasFinalClubDailyRow,
      daysInMonth: dim,
      locked: true,
      lockedAt: new Date().toISOString(),
      timeZone: TIME_ZONE,
      sourceFile: sourceRef
        ? `git:${sourceRef}:${path.posix.join("data", "chronogenesis", fileName)}`
        : path.posix.join("data", "chronogenesis", fileName),
      sourceRef: sourceRef || null,
      archiveFile: path.posix.join("data", "chronogenesis", "archive", archiveFileName),

      frontendConfig: frontendConfig
        ? {
            ...frontendConfig,
            clubConfig: getClubConfig(frontendConfig, clubId),
          }
        : null,
    },
  };

  writeJson(archivePath, archivedJson);
  console.log(`  archived: ${archivePath}`);
  return { clubId, status: "archived", archivePath };
}

function main() {
  if (!fs.existsSync(DATA_DIR)) {
    throw new Error(`Missing directory: ${DATA_DIR}`);
  }

  const previousMonth = getPreviousBangkokMonth(new Date());
  const options = parseArgs(process.argv.slice(2));
  const targetMonth = options.monthKey
    ? parseMonthKey(options.monthKey)
    : previousMonth;

  if (
    options.monthKey &&
    targetMonth.key !== previousMonth.key &&
    !options.sourceRef
  ) {
    throw new Error(
      `Refusing to backfill ${targetMonth.key} from current live files. ` +
      "Provide --source-ref for the historical Git commit that contains that month's payload."
    );
  }

  verifySourceRef(options.sourceRef);
  const frontendConfig = readFrontendConfigForMonth(targetMonth.key);
  const liveFiles = listSourceFiles(options.sourceRef);
  const results = [];

  console.log(
    `Archive source: ${options.sourceRef ? `Git ref ${options.sourceRef}` : "current live files"}`
  );
  console.log(`Archive target month: ${targetMonth.key}`);

  for (const fileName of liveFiles) {
    try {
      results.push(
        archiveOneLiveFile(
          fileName,
          targetMonth,
          frontendConfig,
          options.sourceRef
        )
      );
    } catch (error) {
      const clubId = path.basename(fileName, ".json");
      console.error(`  error: could not archive ${clubId}: ${error.message}`);
      results.push({ clubId, status: "error", reason: error.message });
    }
  }

  updateArchiveManifest();

  const dim = daysInMonth(targetMonth.year, targetMonth.month);
  const expectedClubIds = new Set(
    (Array.isArray(frontendConfig?.clubs) ? frontendConfig.clubs : [])
      .map((club) => String(club?.id ?? ""))
      .filter(Boolean)
  );
  const missingExpectedClubIds = [...expectedClubIds].filter((clubId) => {
    const archivePath = path.join(
      ARCHIVE_DIR,
      `${clubId}_${targetMonth.key}.json`
    );
    return !archiveIsAlreadyLocked(archivePath, targetMonth.key, dim);
  });
  const failedResults = results.filter(
    (result) => result?.status === "incomplete" || result?.status === "error"
  );
  const archivedCount = results.filter((result) => result?.status === "archived").length;
  const lockedCount = results.filter((result) => result?.status === "locked").length;

  console.log(
    `Archive summary for ${targetMonth.key}: ` +
    `archived=${archivedCount}, locked=${lockedCount}, ` +
    `incompleteOrErrored=${failedResults.length}, ` +
    `missingExpected=${missingExpectedClubIds.length}`
  );

  if (missingExpectedClubIds.length) {
    console.error(`Missing expected club archives: ${missingExpectedClubIds.join(", ")}`);
  }

  const bangkokToday = getBangkokDateParts(new Date());
  const graceWindowOpen = !options.monthKey && bangkokToday.day === 1;
  if (
    !options.allowIncomplete &&
    !graceWindowOpen &&
    (missingExpectedClubIds.length > 0 || failedResults.length > 0)
  ) {
    process.exitCode = 1;
  } else if (
    graceWindowOpen &&
    (missingExpectedClubIds.length > 0 || failedResults.length > 0)
  ) {
    console.warn(
      "Archive is still inside the Bangkok first-day grace window; " +
      "later scheduled attempts will retry before an incomplete run is failed."
    );
  }
}

try {
  main();
} catch (error) {
  console.error(`Archive failed: ${error.message}`);
  process.exitCode = 1;
}
