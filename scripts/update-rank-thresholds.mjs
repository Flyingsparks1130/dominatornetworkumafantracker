import fs from "node:fs/promises";
import path from "node:path";

const TIME_ZONE = "Asia/Bangkok";
const OUTPUT_PATH = path.join(process.cwd(), "data", "rank-thresholds.json");
const API_KEY = process.env.UMA_API_KEY?.trim();
const ENDPOINT = process.env.UMA_RANK_THRESHOLDS_URL?.trim() || "https://uma.moe/api/v4/circles/rank-thresholds";
const FORCE_REFRESH = process.env.FORCE_THRESHOLD_REFRESH === "true";

function getCalendarParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date).reduce((result, part) => {
    if (part.type !== "literal") result[part.type] = part.value;
    return result;
  }, {});
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    monthKey: parts.year + "-" + parts.month,
    dateKey: parts.year + "-" + parts.month + "-" + parts.day,
  };
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

async function readExisting() {
  try {
    return JSON.parse(await fs.readFile(OUTPUT_PATH, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function getTrackerCalendar() {
  const dataDirectory = path.join(process.cwd(), "data", "chronogenesis");
  try {
    const filenames = (await fs.readdir(dataDirectory)).filter((filename) => /^\d+\.json$/.test(filename));
    const candidates = [];
    for (const filename of filenames) {
      try {
        const json = JSON.parse(await fs.readFile(path.join(dataDirectory, filename), "utf8"));
        const monthStart = Array.isArray(json?.month_filter) ? json.month_filter[0]?.sdate : null;
        const monthMatch = String(monthStart || "").match(/^(\d{4})-(\d{2})-\d{2}$/);
        const observedDays = (Array.isArray(json?.club_daily_history) ? json.club_daily_history : [])
          .map((row) => Number(row?.actual_date))
          .filter((day) => Number.isFinite(day) && day >= 1 && day <= 31);
        if (!monthMatch || !observedDays.length) continue;
        candidates.push({
          year: Number(monthMatch[1]),
          month: Number(monthMatch[2]),
          day: Math.max(...observedDays),
        });
      } catch (error) {
        console.warn("Could not use Chronogenesis date from " + filename + ": " + error.message);
      }
    }

    if (candidates.length) {
      const counts = new Map();
      candidates.forEach((candidate) => {
        const key = candidate.year + "-" + candidate.month + "-" + candidate.day;
        counts.set(key, (counts.get(key) || 0) + 1);
      });
      candidates.sort((a, b) => {
        const aKey = a.year + "-" + a.month + "-" + a.day;
        const bKey = b.year + "-" + b.month + "-" + b.day;
        const countDifference = (counts.get(bKey) || 0) - (counts.get(aKey) || 0);
        if (countDifference) return countDifference;
        return (b.year * 400 + b.month * 32 + b.day) - (a.year * 400 + a.month * 32 + a.day);
      });
      const selected = candidates[0];
      const monthText = String(selected.month).padStart(2, "0");
      const dayText = String(selected.day).padStart(2, "0");
      return {
        ...selected,
        monthKey: selected.year + "-" + monthText,
        dateKey: selected.year + "-" + monthText + "-" + dayText,
        basis: "Chronogenesis game day",
      };
    }
  } catch (error) {
    console.warn("Could not read the Chronogenesis game day: " + error.message);
  }

  return { ...getCalendarParts(), basis: TIME_ZONE + " calendar fallback" };
}

function hasCurrentMonthMovement(thresholds) {
  return thresholds.some((threshold) => {
    const current = Number(threshold?.current_min_fans);
    const priorMonth = Number(threshold?.last_month_min_fans);
    const reportedDelta = Number(threshold?.current_vs_last_month_delta);
    return (
      (Number.isFinite(current) && Number.isFinite(priorMonth) && current !== priorMonth) ||
      (Number.isFinite(reportedDelta) && reportedDelta !== 0)
    );
  });
}

const calendar = await getTrackerCalendar();
const existing = await readExisting();
const existingToday = existing?.month === calendar.monthKey && existing?.days?.[calendar.day - 1];

if (existingToday && !FORCE_REFRESH) {
  console.log("Rank thresholds already collected for " + calendar.dateKey + "; skipping API request.");
  process.exit(0);
}

if (!API_KEY) throw new Error("Missing UMA_API_KEY GitHub Actions secret");

const response = await fetch(ENDPOINT, {
  method: "GET",
  headers: {
    Accept: "application/json",
    "X-API-Key": API_KEY,
    "User-Agent": "dominator-network-rank-threshold-updater/2.0",
  },
  signal: AbortSignal.timeout(30_000),
});

if (!response.ok) {
  const retryAfter = response.headers.get("retry-after");
  const body = (await response.text()).slice(0, 500);
  throw new Error(
    "UMA rank-threshold request failed (" + response.status + ")" +
    (retryAfter ? "; retry after " + retryAfter : "") +
    ": " + body
  );
}

const rawText = await response.text();
if (rawText.length > 1_000_000) throw new Error("UMA response exceeded the 1 MB safety limit");
const payload = JSON.parse(rawText);
if (!payload || !Array.isArray(payload.thresholds) || payload.thresholds.length === 0) {
  throw new Error("UMA response did not contain a non-empty thresholds array");
}

const populatedThresholds = payload.thresholds.filter((threshold) =>
  Number.isFinite(Number(threshold?.rank_index)) &&
  typeof threshold?.name === "string" &&
  threshold.name.trim()
);
if (populatedThresholds.length < 9) {
  throw new Error("UMA response contained fewer than 9 identifiable rank thresholds");
}

const fetchedAt = new Date().toISOString();
const monthLength = daysInMonth(calendar.year, calendar.month);
const sameMonth = existing?.month === calendar.monthKey;
const days = sameMonth && Array.isArray(existing.days)
  ? Array.from({ length: monthLength }, (_, index) => existing.days[index] ?? null)
  : Array.from({ length: monthLength }, () => null);

const snapshot = {
  day: calendar.day,
  date: calendar.dateKey,
  fetchedAt,
  thresholds: payload.thresholds,
};
days[calendar.day - 1] = snapshot;

const responseShowsCurrentMonth = hasCurrentMonthMovement(payload.thresholds);
const currentMonthActive = Boolean(sameMonth && existing?.currentMonthActive) || responseShowsCurrentMonth;
const activationDay = currentMonthActive
  ? (sameMonth && existing?.activationDay ? existing.activationDay : calendar.day)
  : null;

const output = {
  schemaVersion: 2,
  source: "uma.moe rank tier thresholds",
  timeZone: TIME_ZONE,
  dayBasis: calendar.basis,
  month: calendar.monthKey,
  daysInMonth: monthLength,
  updatedAt: fetchedAt,
  currentMonthActive,
  activationDay,
  latest: snapshot,
  days,
};

await fs.mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
const temporaryPath = OUTPUT_PATH + ".tmp";
await fs.writeFile(temporaryPath, JSON.stringify(output, null, 2) + "\n", "utf8");
await fs.rename(temporaryPath, OUTPUT_PATH);

console.log(
  "Saved " + payload.thresholds.length + " thresholds for " + calendar.dateKey +
  " (" + (currentMonthActive ? "current month active" : "awaiting current-month movement") + ")."
);
