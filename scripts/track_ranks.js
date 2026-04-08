#!/usr/bin/env node
/**
 * Dominator Monthly Rank History Tracker
 *
 * Scans data/ for circle JSON files, extracts `monthly_rank`
 * and `monthly_point`, and writes per-club history files into
 * data/club_rank_history/<circle_id>.json.
 *
 * Usage:
 *   node scripts/track_ranks.js
 *
 * Reads:   data/*.json                         (circle data files)
 * Writes:  data/club_rank_history/<id>.json   (one per club)
 *
 * Exit codes:
 *   0 = success (updates written or nothing new)
 *   1 = no valid circle data found (signals upstream failure)
 */

const fs = require("fs");
const path = require("path");

// ── Config ─────────────────────────────────────────────────────────────

const DATA_DIR = path.resolve(__dirname, "..", "data");
const CLUBS_FILE = path.join(DATA_DIR, "clubs.json");
const OUTPUT_DIR = path.join(DATA_DIR, "club_rank_history");

// Match the HTML app's ET refresh schedule / reset behavior
const GAME_RESET_LOCAL_HOUR = 11;
const REFRESH_SCHEDULE_TIMEZONE = "America/New_York";
const REFRESH_SCHEDULE_SLOTS = [
  { hour: 0, minute: 0, label: "12:00 AM" },
  { hour: 1, minute: 0, label: "1:00 AM" },
  { hour: 5, minute: 0, label: "5:00 AM" },
  { hour: 6, minute: 0, label: "6:00 AM" },
  { hour: 14, minute: 0, label: "2:00 PM" },
  { hour: 15, minute: 0, label: "3:00 PM" },
  { hour: 19, minute: 0, label: "7:00 PM" },
  { hour: 20, minute: 0, label: "8:00 PM" },
];

// ── Date logic (ET-based, aligned to the app) ──────────────────────────

function pad2(n) {
  return String(n).padStart(2, "0");
}

function formatDateKey(year, month, day) {
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

function isDateKey(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
}

function shiftDateKey(key, deltaDays) {
  const [year, month, day] = String(key).split("-").map(Number);
  const utc = new Date(Date.UTC(year, month - 1, day));
  utc.setUTCDate(utc.getUTCDate() + deltaDays);
  return formatDateKey(
    utc.getUTCFullYear(),
    utc.getUTCMonth() + 1,
    utc.getUTCDate()
  );
}

function shiftDateKeyWithinSameMonth(key, deltaDays) {
  if (!isDateKey(key)) return key;
  const shifted = shiftDateKey(key, deltaDays);
  return shifted.slice(0, 7) === key.slice(0, 7) ? shifted : key;
}

function getPreviousDisplayKeyFromKey(key) {
  return shiftDateKeyWithinSameMonth(key, -1);
}

function getTimeZoneParts(date, timeZone = REFRESH_SCHEDULE_TIMEZONE) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  })
    .formatToParts(date)
    .reduce((acc, part) => {
      if (part.type !== "literal") acc[part.type] = part.value;
      return acc;
    }, {});

  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

function parseShortOffsetToMinutes(offsetLabel) {
  const normalized = String(offsetLabel || "GMT").replace("UTC", "GMT");
  if (normalized === "GMT") return 0;

  const match = normalized.match(/^GMT([+-])(\d{1,2})(?::?(\d{2}))?$/);
  if (!match) return 0;

  const sign = match[1] === "-" ? -1 : 1;
  const hours = Number(match[2] || 0);
  const minutes = Number(match[3] || 0);
  return sign * ((hours * 60) + minutes);
}

function getTimeZoneOffsetMinutes(date, timeZone = REFRESH_SCHEDULE_TIMEZONE) {
  const tzNamePart = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "shortOffset",
    hour: "2-digit",
  })
    .formatToParts(date)
    .find((part) => part.type === "timeZoneName");

  return parseShortOffsetToMinutes(tzNamePart?.value || "GMT");
}

function zonedTimeToUtc(parts, timeZone = REFRESH_SCHEDULE_TIMEZONE) {
  const utcGuessMs = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour || 0,
    parts.minute || 0,
    parts.second || 0,
    0
  );

  const initialOffset = getTimeZoneOffsetMinutes(new Date(utcGuessMs), timeZone);
  let resolved = new Date(utcGuessMs - initialOffset * 60 * 1000);

  const resolvedOffset = getTimeZoneOffsetMinutes(resolved, timeZone);
  if (resolvedOffset !== initialOffset) {
    resolved = new Date(utcGuessMs - resolvedOffset * 60 * 1000);
  }

  return resolved;
}

function getEtTodayKey(now = new Date()) {
  const et = getTimeZoneParts(now, REFRESH_SCHEDULE_TIMEZONE);
  return formatDateKey(et.year, et.month, et.day);
}

function isAfterResetHourEt(now = new Date()) {
  const et = getTimeZoneParts(now, REFRESH_SCHEDULE_TIMEZONE);
  return et.hour >= GAME_RESET_LOCAL_HOUR;
}

function getResetCycleKeyEt(now = new Date()) {
  const todayKey = getEtTodayKey(now);
  return isAfterResetHourEt(now)
    ? todayKey
    : getPreviousDisplayKeyFromKey(todayKey);
}

function getEffectiveDayWindowEt(now = new Date()) {
  const resetCycleKey = getResetCycleKeyEt(now);
  const latestDisplayKey = resetCycleKey;
  const previousDisplayKey = getPreviousDisplayKeyFromKey(latestDisplayKey);
  return { resetCycleKey, latestDisplayKey, previousDisplayKey };
}

function getFirstScheduledRefreshAfterReset(now = new Date()) {
  const et = getTimeZoneParts(now, REFRESH_SCHEDULE_TIMEZONE);

  const postResetSlots = REFRESH_SCHEDULE_SLOTS.filter(
    (slot) => (slot.hour * 60 + slot.minute) > (GAME_RESET_LOCAL_HOUR * 60)
  ).sort((a, b) => (a.hour * 60 + a.minute) - (b.hour * 60 + b.minute));

  if (postResetSlots.length === 0) return null;

  const firstSlot = postResetSlots[0];

  return {
    ...firstSlot,
    date: zonedTimeToUtc(
      {
        year: et.year,
        month: et.month,
        day: et.day,
        hour: firstSlot.hour,
        minute: firstSlot.minute,
        second: 0,
      },
      REFRESH_SCHEDULE_TIMEZONE
    ),
  };
}

/**
 * Rank-history effective day rule:
 *
 * - Before the ET 11:00 AM indicator:
 *     game day = previous day
 *
 * - After 11:00 AM ET:
 *     still stay on previous day until the first scheduled ET refresh
 *     after 11:00 AM has started
 *
 * - Once that first post-11 scheduled refresh has started:
 *     switch to current day
 *
 * This intentionally ignores JST source timestamps for the history date,
 * because source timestamps can look like the "next day" in UTC/JST and
 * drift the rank history ahead of the app.
 */
function resolveEffectiveRankHistoryDayKey(now = new Date()) {
  const { latestDisplayKey, previousDisplayKey } = getEffectiveDayWindowEt(now);

  if (!isAfterResetHourEt(now)) return previousDisplayKey;

  const firstPostResetRefresh = getFirstScheduledRefreshAfterReset(now);
  if (!firstPostResetRefresh) return previousDisplayKey;

  if (now.getTime() >= firstPostResetRefresh.date.getTime()) {
    return latestDisplayKey;
  }

  return previousDisplayKey;
}

// ── Per-club history I/O ──────────────────────────────────────────────

function loadClubHistory(circleId) {
  const filePath = path.join(OUTPUT_DIR, `${circleId}.json`);
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

function saveClubHistory(circleId, data) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const filePath = path.join(OUTPUT_DIR, `${circleId}.json`);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

// ── Find circle data files in data/ ───────────────────────────────────

function getClubIds() {
  try {
    const clubs = JSON.parse(fs.readFileSync(CLUBS_FILE, "utf-8"));
    if (Array.isArray(clubs)) {
      return clubs.map((c) => ({ id: String(c.id), name: c.name }));
    }
  } catch {}
  return null;
}

function findCircleFiles() {
  const clubList = getClubIds();
  const files = fs.readdirSync(DATA_DIR).filter((f) => f.endsWith(".json"));
  const results = [];

  for (const file of files) {
    if (file === "clubs.json") continue;

    const filePath = path.join(DATA_DIR, file);

    // Skip directories (like club_rank_history/)
    if (!fs.statSync(filePath).isFile()) continue;

    try {
      const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      const circle = raw.circle || raw;

      if (!circle.circle_id || circle.monthly_rank == null) continue;

      const id = String(circle.circle_id);

      // If manifest exists, only process listed clubs
      if (clubList && !clubList.some((c) => c.id === id)) continue;

      const manifestEntry = clubList?.find((c) => c.id === id);

      results.push({
        id,
        name: manifestEntry?.name || circle.name || id,
        circle,
        file,
        raw,
      });
    } catch {
      // Not a valid circle file, skip
    }
  }

  return results;
}

// ── Main ───────────────────────────────────────────────────────────────

function main() {
  console.log(`Source:  ${DATA_DIR}`);
  console.log(`Output:  ${OUTPUT_DIR}\n`);

  const circleFiles = findCircleFiles();

  if (circleFiles.length === 0) {
    console.error("No valid circle data files found in data/. Aborting.");
    process.exit(1);
  }

  const now = new Date();
  const effectiveDateKey = resolveEffectiveRankHistoryDayKey(now);
  const firstPostResetRefresh = getFirstScheduledRefreshAfterReset(now);
  const { latestDisplayKey, previousDisplayKey } = getEffectiveDayWindowEt(now);

  console.log(`ET now:                 ${new Intl.DateTimeFormat("en-US", {
    timeZone: REFRESH_SCHEDULE_TIMEZONE,
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(now)}`);
  console.log(`Previous display key:   ${previousDisplayKey}`);
  console.log(`Latest display key:     ${latestDisplayKey}`);
  console.log(`Effective history day:  ${effectiveDateKey}`);
  if (firstPostResetRefresh) {
    console.log(
      `First post-11 refresh:  ${firstPostResetRefresh.label} ET`
    );
  }
  console.log("");

  let updated = 0;

  for (const { id, name, circle, raw } of circleFiles) {
    const rank = circle.monthly_rank;
    const points = circle.monthly_point ?? null;

    // Keep raw source timestamps for debugging, but do NOT use them
    // to decide the history day key.
    const sourceUpdatedAt =
      raw?.refreshed_at ||
      raw?.meta?.refreshed_at ||
      circle.last_updated ||
      circle.yesterday_updated ||
      null;

    // Load or initialise this club's history file
    const existing = loadClubHistory(id) || { id, name, history: {} };
    existing.name = name;

    const prev = existing.history[effectiveDateKey];

    // Skip if identical data already recorded
    if (
      prev &&
      prev.rank === rank &&
      prev.points === points
    ) {
      console.log(
        `  ·  ${name.padEnd(14)} │ ${effectiveDateKey} │ rank ${String(rank).padStart(4)} │ (unchanged)`
      );
      continue;
    }

    const overwrite = !!prev;

    existing.history[effectiveDateKey] = {
      rank,
      points,
      recorded_at: new Date().toISOString(),
      source_updated_at: sourceUpdatedAt,
      effective_game_day_key: effectiveDateKey,
    };

    saveClubHistory(id, existing);

    const symbol = overwrite ? "↻" : "✓";
    console.log(
      `  ${symbol}  ${name.padEnd(14)} │ ${effectiveDateKey} │ rank ${String(rank).padStart(4)} │ pts ${points ?? "—"}`
    );
    updated++;
  }

  console.log(
    `\n${updated > 0 ? `Saved ${updated} update(s)` : "No new updates"} → ${OUTPUT_DIR}`
  );
}

main();
