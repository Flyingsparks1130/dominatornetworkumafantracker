import fs from "node:fs";
import path from "node:path";

const DATA_DIR = path.join("data", "chronogenesis");
const ARCHIVE_DIR = path.join(DATA_DIR, "archive");
const TIME_ZONE = "Asia/Bangkok";

fs.mkdirSync(ARCHIVE_DIR, { recursive: true });

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

  // JS month is 0-indexed. current.month - 2 means previous calendar month.
  const previous = new Date(Date.UTC(current.year, current.month - 2, 1));

  const year = previous.getUTCFullYear();
  const month = previous.getUTCMonth() + 1;

  return {
    year,
    month,
    key: `${year}-${pad2(month)}`,
  };
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n");
}

function getClubRoot(json) {
  return Array.isArray(json?.club) ? json.club[0] : null;
}

function getClubIdFromJson(json, fallbackClubId) {
  const clubRoot = getClubRoot(json);

  return String(
    clubRoot?.circle_id ??
    clubRoot?.id ??
    clubRoot?.club_id ??
    fallbackClubId
  );
}

function getMaxActualDate(json, dim) {
  const rows = Array.isArray(json?.club_friend_history)
    ? json.club_friend_history
    : [];

  return rows.reduce((maxDay, row) => {
    const actualDate = Number(row?.actual_date);
    if (!Number.isFinite(actualDate)) return maxDay;
    if (actualDate < 1 || actualDate > dim) return maxDay;
    return Math.max(maxDay, actualDate);
  }, 0);
}

function getSharedActualDate(json, dim) {
  const clubRoot = getClubRoot(json);
  if (!clubRoot) return 0;

  const friendProfiles = Array.isArray(json?.club_friend_profile)
    ? json.club_friend_profile
    : [];

  const friendHistory = Array.isArray(json?.club_friend_history)
    ? json.club_friend_history
    : [];

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

    if (!historyDaysByViewerId[key]) {
      historyDaysByViewerId[key] = new Set();
    }

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

    if (everyoneHasDay) {
      sharedMax = day;
    }
  }

  return sharedMax;
}

function archiveIsAlreadyLocked(archivePath, monthKey, dim) {
  if (!fs.existsSync(archivePath)) return false;

  try {
    const archived = readJson(archivePath);
    return (
      archived?._archive?.source === "chronogenesis" &&
      archived?._archive?.month === monthKey &&
      archived?._archive?.locked === true &&
      Number(archived?._archive?.completedActualDate) >= dim
    );
  } catch {
    return false;
  }
}

function updateArchiveManifest() {
  const files = fs
    .readdirSync(ARCHIVE_DIR)
    .filter((file) => /^\d+-\d{4}-\d{2}\.json$/.test(file))
    .sort();

  const manifest = {
    generatedAt: new Date().toISOString(),
    files,
    months: {},
    clubs: {},
  };

  for (const file of files) {
    const match = file.match(/^(\d+)-(\d{4}-\d{2})\.json$/);
    if (!match) continue;

    const [, clubId, monthKey] = match;

    if (!manifest.months[monthKey]) manifest.months[monthKey] = [];
    if (!manifest.clubs[clubId]) manifest.clubs[clubId] = [];

    manifest.months[monthKey].push(clubId);
    manifest.clubs[clubId].push(monthKey);
  }

  writeJson(path.join(ARCHIVE_DIR, "index.json"), manifest);
}

function archiveOneLiveFile(fileName, previousMonth) {
  if (!fileName.endsWith(".json")) return;
  if (fileName === "index.json") return;

  const sourcePath = path.join(DATA_DIR, fileName);
  const stat = fs.statSync(sourcePath);

  if (!stat.isFile()) return;

  const fallbackClubId = path.basename(fileName, ".json");
  const json = readJson(sourcePath);

  const clubId = getClubIdFromJson(json, fallbackClubId);
  const dim = daysInMonth(previousMonth.year, previousMonth.month);

  const sharedActualDate = getSharedActualDate(json, dim);
  const maxActualDate = getMaxActualDate(json, dim);

  const archiveFileName = `${clubId}-${previousMonth.key}.json`;
  const archivePath = path.join(ARCHIVE_DIR, archiveFileName);

  console.log(
    `${clubId}: previousMonth=${previousMonth.key}, sharedActualDate=${sharedActualDate}, maxActualDate=${maxActualDate}, dim=${dim}`
  );

  if (archiveIsAlreadyLocked(archivePath, previousMonth.key, dim)) {
    console.log(`  locked already: ${archivePath}`);
    return;
  }

  // Main lock condition:
  // Only archive when the completed previous month is present.
  if (sharedActualDate < dim) {
    console.log(`  skip: sharedActualDate is not complete yet`);
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
      maxActualDate,
      daysInMonth: dim,
      locked: true,
      lockedAt: new Date().toISOString(),
      timeZone: TIME_ZONE,
      sourceFile: path.posix.join("data", "chronogenesis", fileName),
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

  const liveFiles = fs
    .readdirSync(DATA_DIR)
    .filter((fileName) => {
      const fullPath = path.join(DATA_DIR, fileName);
      return fs.statSync(fullPath).isFile() && fileName.endsWith(".json");
    });

  for (const fileName of liveFiles) {
    archiveOneLiveFile(fileName, previousMonth);
  }

  updateArchiveManifest();
}

main();
