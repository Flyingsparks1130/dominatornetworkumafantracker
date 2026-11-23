import fs from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const CONFIG_PATH = path.join(ROOT, "config", "frontend.json");
const OUTPUT_PATH = path.join(ROOT, "data", "network-leaderboard.json");
const LOCK_PATH = path.join(ROOT, "data", ".network-leaderboard.lock");
const API_KEY = process.env.UMA_API_KEY?.trim();
const API_URL = process.env.UMA_CIRCLES_URL?.trim() || "https://uma.moe/api/v4/circles/list";
const EXPECTED_REFRESH_MINUTES = clampInteger(process.env.LEADERBOARD_EXPECTED_REFRESH_MINUTES, 5, 1440, 60);
const BOOTSTRAP_MODE = process.argv.includes("--bootstrap");
const REQUEST_CONCURRENCY = clampInteger(process.env.UMA_REQUEST_CONCURRENCY, 1, 5, 3);
const REQUEST_ATTEMPTS = clampInteger(process.env.UMA_REQUEST_ATTEMPTS, 1, 6, 3);
const LOCK_MAX_AGE_MS = 15 * 60 * 1000;

function clampInteger(value, minimum, maximum, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function safeIso(value) {
  if (!value) return null;
  const normalized = String(value).replace(/(\.\d{3})\d+/, "$1");
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

async function acquireLock() {
  await fs.mkdir(path.dirname(LOCK_PATH), { recursive: true });
  try {
    return await fs.open(LOCK_PATH, "wx");
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const stat = await fs.stat(LOCK_PATH).catch(() => null);
    if (!stat || Date.now() - stat.mtimeMs <= LOCK_MAX_AGE_MS) {
      throw new Error("Another network leaderboard update is already running.");
    }
    console.warn("Removing a stale network leaderboard lock.");
    await fs.rm(LOCK_PATH, { force: true });
    return fs.open(LOCK_PATH, "wx");
  }
}

async function writeJsonAtomic(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  try {
    await fs.rename(temporaryPath, filePath);
  } catch (error) {
    if (!["EEXIST", "EPERM"].includes(error?.code)) throw error;
    await fs.copyFile(temporaryPath, filePath);
    await fs.rm(temporaryPath, { force: true });
  }
}

function currentRankFor(circle) {
  return finiteNumber(circle?.live_rank) ?? finiteNumber(circle?.monthly_rank);
}

function currentPointsFor(circle) {
  return finiteNumber(circle?.live_points) ?? finiteNumber(circle?.monthly_point);
}

function selectExactCircle(payload, clubId) {
  if (!Array.isArray(payload?.circles)) throw new Error("Response did not contain a circles array.");
  const exact = payload.circles.find((circle) => String(circle?.circle_id) === String(clubId));
  if (!exact) throw new Error(`Circle ${clubId} was not returned by the API.`);
  return exact;
}

function retryDelay(response, attempt) {
  const retryAfter = response?.headers?.get?.("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.min(60_000, Math.max(1_000, seconds * 1_000));
    const date = new Date(retryAfter);
    if (!Number.isNaN(date.getTime())) return Math.min(60_000, Math.max(1_000, date.getTime() - Date.now()));
  }
  return Math.min(15_000, 1_000 * (2 ** attempt));
}

async function requestCircle(club) {
  const url = new URL(API_URL);
  url.searchParams.set("query", String(club.id));
  url.searchParams.set("page", "0");
  url.searchParams.set("limit", "25");

  let lastError = null;
  for (let attempt = 0; attempt < REQUEST_ATTEMPTS; attempt += 1) {
    let response = null;
    try {
      response = await fetch(url, {
        headers: {
          Accept: "application/json",
          "X-API-Key": API_KEY,
          "User-Agent": "dominator-network-leaderboard-updater/1.0",
        },
        signal: AbortSignal.timeout(30_000),
      });

      if (!response.ok) {
        const body = (await response.text()).slice(0, 400);
        const error = new Error(`HTTP ${response.status}${body ? `: ${body}` : ""}`);
        error.retryable = response.status === 429 || response.status >= 500;
        throw error;
      }

      const rawText = await response.text();
      if (rawText.length > 2_000_000) throw new Error("Response exceeded the 2 MB safety limit.");
      return selectExactCircle(JSON.parse(rawText), club.id);
    } catch (error) {
      lastError = error;
      const retryable = error?.name === "TimeoutError" || error?.name === "AbortError" || error?.retryable;
      if (!retryable || attempt === REQUEST_ATTEMPTS - 1) break;
      await sleep(retryDelay(response, attempt));
    }
  }
  throw lastError || new Error("Unknown API request failure.");
}

function normalizeApiRow(club, circle, previousRow, fetchedAt) {
  const globalRank = currentRankFor(circle);
  const previousRefreshRank = finiteNumber(previousRow?.globalRank);
  const yesterdayRank = finiteNumber(circle?.yesterday_rank);
  const liveRank = finiteNumber(circle?.live_rank);
  const livePoints = finiteNumber(circle?.live_points);

  return {
    id: String(club.id),
    configuredName: club.name,
    name: String(circle?.name || club.name),
    networkTier: club.tier,
    officer: club.officer || "",
    globalRank,
    officialTier: tierForRank(globalRank),
    rankSource: liveRank != null ? "live" : "monthly",
    previousRefreshRank,
    rankChange: globalRank != null && previousRefreshRank != null ? previousRefreshRank - globalRank : null,
    yesterdayRank,
    dailyRankChange: globalRank != null && yesterdayRank != null ? yesterdayRank - globalRank : null,
    points: currentPointsFor(circle),
    pointsSource: livePoints != null ? "live" : "monthly",
    monthlyRank: finiteNumber(circle?.monthly_rank),
    monthlyPoints: finiteNumber(circle?.monthly_point),
    lastMonthRank: finiteNumber(circle?.last_month_rank),
    lastMonthPoints: finiteNumber(circle?.last_month_point),
    yesterdayPoints: finiteNumber(circle?.yesterday_points),
    memberCount: finiteNumber(circle?.member_count),
    leaderName: circle?.leader_name || null,
    apiLastUpdated: safeIso(circle?.last_updated),
    lastLiveUpdate: safeIso(circle?.last_live_update),
    fetchedAt,
    fresh: true,
    staleReason: null,
  };
}

function tierForRank(rank) {
  if (!Number.isFinite(rank)) return null;
  if (rank <= 10) return "SS";
  if (rank <= 30) return "S+";
  if (rank <= 100) return "S";
  if (rank <= 500) return "A+";
  if (rank <= 1000) return "A";
  if (rank <= 3000) return "B+";
  if (rank <= 5000) return "B";
  if (rank <= 7000) return "C+";
  if (rank <= 10000) return "C";
  return "D+";
}

function staleRow(club, previousRow, reason) {
  if (!previousRow) {
    return {
      id: String(club.id),
      configuredName: club.name,
      name: club.name,
      networkTier: club.tier,
      officer: club.officer || "",
      globalRank: null,
      officialTier: null,
      rankSource: null,
      previousRefreshRank: null,
      rankChange: null,
      yesterdayRank: null,
      dailyRankChange: null,
      points: null,
      pointsSource: null,
      monthlyRank: null,
      monthlyPoints: null,
      lastMonthRank: null,
      lastMonthPoints: null,
      yesterdayPoints: null,
      memberCount: null,
      leaderName: null,
      apiLastUpdated: null,
      lastLiveUpdate: null,
      fetchedAt: null,
      fresh: false,
      staleReason: reason,
    };
  }
  return {
    ...previousRow,
    configuredName: club.name,
    networkTier: club.tier,
    officer: club.officer || "",
    fresh: false,
    staleReason: reason,
  };
}

async function mapWithConcurrency(items, concurrency, worker) {
  const results = Array(items.length);
  let cursor = 0;
  async function run() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => run()));
  return results;
}

function latestChronogenesisDay(dataset) {
  const history = Array.isArray(dataset?.club_daily_history) ? dataset.club_daily_history : [];
  return history
    .filter((row) => Number.isFinite(Number(row?.actual_date)) && Number.isFinite(Number(row?.rank)))
    .sort((a, b) => Number(b.actual_date) - Number(a.actual_date))[0] || null;
}

async function bootstrapFromChronogenesis(clubs, previous) {
  const previousRows = new Map((previous?.clubs || []).map((row) => [String(row.id), row]));
  const rows = [];
  for (const club of clubs) {
    const dataset = await readJson(path.join(ROOT, "data", "chronogenesis", `${club.id}.json`), null);
    const clubRecord = Array.isArray(dataset?.club) ? dataset.club[0] : dataset?.club;
    const day = latestChronogenesisDay(dataset);
    const currentRank = finiteNumber(day?.rank) ?? finiteNumber(clubRecord?.rank);
    const prior = previousRows.get(String(club.id));
    rows.push({
      id: String(club.id),
      configuredName: club.name,
      name: clubRecord?.name || club.name,
      networkTier: club.tier,
      officer: club.officer || "",
      globalRank: currentRank,
      officialTier: tierForRank(currentRank),
      rankSource: "chronogenesis-bootstrap",
      previousRefreshRank: finiteNumber(prior?.globalRank),
      rankChange: finiteNumber(day?.rank_gain),
      yesterdayRank: currentRank != null && finiteNumber(day?.rank_gain) != null ? currentRank + finiteNumber(day.rank_gain) : null,
      dailyRankChange: finiteNumber(day?.rank_gain),
      points: finiteNumber(day?.interpolated_fan_count),
      pointsSource: "chronogenesis-bootstrap",
      monthlyRank: currentRank,
      monthlyPoints: finiteNumber(day?.interpolated_fan_count),
      lastMonthRank: null,
      lastMonthPoints: null,
      yesterdayPoints: null,
      memberCount: finiteNumber(clubRecord?.member_num),
      leaderName: null,
      apiLastUpdated: safeIso(clubRecord?.updated_at),
      lastLiveUpdate: null,
      fetchedAt: safeIso(clubRecord?.updated_at),
      fresh: false,
      staleReason: "Waiting for the first uma.moe cron refresh.",
    });
  }
  return rows;
}

function sortAndPosition(rows) {
  return [...rows]
    .sort((a, b) => {
      const aRank = finiteNumber(a.globalRank) ?? Number.POSITIVE_INFINITY;
      const bRank = finiteNumber(b.globalRank) ?? Number.POSITIVE_INFINITY;
      return aRank - bRank || String(a.name).localeCompare(String(b.name));
    })
    .map((row, index) => ({ ...row, networkPosition: index + 1 }));
}

async function main() {
  const config = await readJson(CONFIG_PATH);
  const clubs = Array.isArray(config?.clubs) ? config.clubs.filter((club) => club?.id && club?.name) : [];
  if (!clubs.length) throw new Error("config/frontend.json did not contain any clubs.");

  const previous = await readJson(OUTPUT_PATH, null);
  const previousRows = new Map((previous?.clubs || []).map((row) => [String(row.id), row]));
  const fetchedAt = new Date().toISOString();
  let rows = [];
  let successfulRequests = 0;
  const failures = [];

  if (BOOTSTRAP_MODE) {
    rows = await bootstrapFromChronogenesis(clubs, previous);
  } else {
    if (!API_KEY) throw new Error("Missing UMA_API_KEY environment variable.");
    rows = await mapWithConcurrency(clubs, REQUEST_CONCURRENCY, async (club) => {
      try {
        const circle = await requestCircle(club);
        successfulRequests += 1;
        return normalizeApiRow(club, circle, previousRows.get(String(club.id)), fetchedAt);
      } catch (error) {
        const reason = String(error?.message || error).slice(0, 300);
        failures.push({ id: String(club.id), name: club.name, error: reason });
        console.error(`${club.name} (${club.id}): ${reason}`);
        return staleRow(club, previousRows.get(String(club.id)), reason);
      }
    });

    if (successfulRequests === 0) {
      throw new Error("All uma.moe circle requests failed; the existing leaderboard snapshot was preserved.");
    }
  }

  const sortedRows = sortAndPosition(rows);
  const sourceUpdates = sortedRows
    .flatMap((row) => [safeIso(row.lastLiveUpdate), safeIso(row.apiLastUpdated)])
    .filter(Boolean)
    .sort();

  const output = {
    schemaVersion: 1,
    source: BOOTSTRAP_MODE ? "Chronogenesis bootstrap; awaiting uma.moe cron refresh" : "uma.moe circles",
    apiEndpoint: "/api/v4/circles/list",
    updatedAt: fetchedAt,
    sourceUpdatedAt: sourceUpdates.at(-1) || null,
    previousUpdatedAt: previous?.updatedAt || null,
    expectedRefreshMinutes: EXPECTED_REFRESH_MINUTES,
    complete: BOOTSTRAP_MODE ? false : failures.length === 0,
    bootstrap: BOOTSTRAP_MODE,
    freshCount: BOOTSTRAP_MODE ? 0 : successfulRequests,
    staleCount: BOOTSTRAP_MODE ? sortedRows.length : failures.length,
    failures,
    clubs: sortedRows,
  };

  await writeJsonAtomic(OUTPUT_PATH, output);
  console.log(
    BOOTSTRAP_MODE
      ? `Created a ${sortedRows.length}-club bootstrap snapshot.`
      : `Updated ${successfulRequests}/${sortedRows.length} clubs${failures.length ? `; preserved ${failures.length} stale row(s)` : ""}.`
  );
}

const lockHandle = await acquireLock();
try {
  await main();
} finally {
  await lockHandle.close().catch(() => {});
  await fs.rm(LOCK_PATH, { force: true }).catch(() => {});
}
