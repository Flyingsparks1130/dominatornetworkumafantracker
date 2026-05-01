import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const DATA_DIR = path.join("data", "chronogenesis");
const ARCHIVE_DIR = path.join(DATA_DIR, "archive");
const CONFIG_DIR = path.join(ARCHIVE_DIR, "config");
const INDEX_PATH = path.join("index.html");
const TIME_ZONE = "Asia/Bangkok";

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

function getSharedActualDate(json, dim) {
  const clubRoot = getClubRoot(json);
  if (!clubRoot) return 0;

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

  if (!activeProfileViewerIds.length) return 0;

  let sharedMax = 0;
  for (let day = 1; day <= dim; day++) {
    const everyoneHasDay = activeProfileViewerIds.every((viewerId) =>
      historyDaysByViewerId[viewerId]?.has(day)
    );

    if (everyoneHasDay) sharedMax = day;
  }

  return sharedMax;
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
      archiveMeta.completedActualDate ??
      getSharedActualDate(archived, dim)
    );

    const hasFinalClubDailyRow = hasActualDate(archived?.club_daily_history, dim);

    const isLocked =
      archiveMeta.source === "chronogenesis" &&
      archiveMeta.month === monthKey &&
      archiveMeta.locked === true &&
      archiveShared >= dim &&
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

  const manifest = {
    generatedAt: new Date().toISOString(),
    files,
    months: [...monthMap.values()].sort((a, b) => b.key.localeCompare(a.key)),
    clubs: Object.fromEntries(
      [...clubMap.entries()].map(([clubId, months]) => [clubId, months.sort()])
    ),
    configFiles: fs.existsSync(CONFIG_DIR)
      ? fs.readdirSync(CONFIG_DIR).filter((file) => /^\d{4}-\d{2}\.json$/.test(file)).sort()
      : [],
  };

  writeJson(path.join(ARCHIVE_DIR, "manifest.json"), manifest);
  writeJson(path.join(ARCHIVE_DIR, "index.json"), manifest);
}

function archiveOneLiveFile(fileName, previousMonth, frontendConfig) {
  if (!fileName.endsWith(".json")) return;
  if (fileName === "index.json" || fileName === "manifest.json") return;

  const sourcePath = path.join(DATA_DIR, fileName);
  const stat = fs.statSync(sourcePath);
  if (!stat.isFile()) return;

  const fallbackClubId = path.basename(fileName, ".json");
  const json = readJson(sourcePath);
  const clubId = getClubIdFromJson(json, fallbackClubId);

  const dim = daysInMonth(previousMonth.year, previousMonth.month);

  const sharedActualDate = getSharedActualDate(json, dim);
  const maxFriendHistoryActualDate = getMaxFriendHistoryActualDate(json, dim);
  const maxClubDailyHistoryActualDate = getMaxClubDailyHistoryActualDate(json, dim);
  const hasFinalClubDailyRow = hasActualDate(json?.club_daily_history, dim);

  const archiveFileName = `${clubId}_${previousMonth.key}.json`;
  const archivePath = path.join(ARCHIVE_DIR, archiveFileName);

  console.log(
    `${clubId}: previousMonth=${previousMonth.key}, ` +
    `sharedActualDate=${sharedActualDate}, ` +
    `friendMax=${maxFriendHistoryActualDate}, ` +
    `clubDailyMax=${maxClubDailyHistoryActualDate}, ` +
    `dim=${dim}`
  );

  if (archiveIsAlreadyLocked(archivePath, previousMonth.key, dim)) {
    console.log(`  locked already: ${archivePath}`);
    return;
  }

  if (sharedActualDate < dim) {
    console.log("  skip: sharedActualDate is not complete yet");
    return;
  }

  if (maxFriendHistoryActualDate < dim) {
    console.log("  skip: club_friend_history is not complete yet");
    return;
  }

  if (maxClubDailyHistoryActualDate < dim || !hasFinalClubDailyRow) {
    console.log(
      `  skip: club_daily_history is not complete yet ` +
      `(clubDailyMax=${maxClubDailyHistoryActualDate}, hasDay${dim}=${hasFinalClubDailyRow})`
    );
    return;
  }

  const archivedJson = {
    ...json,
    _archive: {
      source: "chronogenesis",
      clubId,
      month: previousMonth.key,
      year: previousMonth.year,
      monthNumber: previousMonth.month,

      completedActualDate: sharedActualDate,
      maxActualDate: maxFriendHistoryActualDate,
      maxFriendHistoryActualDate,
      maxClubDailyHistoryActualDate,

      hasFinalClubDailyRow,
      daysInMonth: dim,
      locked: true,
      lockedAt: new Date().toISOString(),
      timeZone: TIME_ZONE,
      sourceFile: path.posix.join("data", "chronogenesis", fileName),
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
}

function main() {
  if (!fs.existsSync(DATA_DIR)) {
    throw new Error(`Missing directory: ${DATA_DIR}`);
  }

  const previousMonth = getPreviousBangkokMonth(new Date());
  const frontendConfig = readFrontendConfigForMonth(previousMonth.key);

  const liveFiles = fs
    .readdirSync(DATA_DIR)
    .filter((fileName) => {
      const fullPath = path.join(DATA_DIR, fileName);
      return fs.statSync(fullPath).isFile() && fileName.endsWith(".json");
    });

  for (const fileName of liveFiles) {
    archiveOneLiveFile(fileName, previousMonth, frontendConfig);
  }

  updateArchiveManifest();
}

main();
