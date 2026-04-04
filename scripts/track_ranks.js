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
 * Reads:   data/*.json                       (circle data files)
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

// ── Date logic (exact port of HTML app) ───────────────────────────────

const GAME_RESET_LOCAL_HOUR = 11;

function pad2(n) {
  return String(n).padStart(2, "0");
}

function formatDateKey(year, month, day) {
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

function formatLocalDateKey(date) {
  return formatDateKey(date.getFullYear(), date.getMonth() + 1, date.getDate());
}

function isDateKey(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
}

function shiftDateKey(key, deltaDays) {
  const [year, month, day] = String(key).split("-").map(Number);
  const utc = new Date(Date.UTC(year, month - 1, day));
  utc.setUTCDate(utc.getUTCDate() + deltaDays);
  return formatDateKey(utc.getUTCFullYear(), utc.getUTCMonth() + 1, utc.getUTCDate());
}

function getLocalTodayKey(now = new Date()) {
  return formatLocalDateKey(now);
}

function isAfterResetHour(now = new Date()) {
  return now.getHours() >= GAME_RESET_LOCAL_HOUR;
}

function shiftDateKeyWithinSameMonth(key, deltaDays) {
  if (!isDateKey(key)) return key;
  const shifted = shiftDateKey(key, deltaDays);
  return shifted.slice(0, 7) === key.slice(0, 7) ? shifted : key;
}

function getPreviousDisplayKeyFromKey(key) {
  return shiftDateKeyWithinSameMonth(key, -1);
}

function getDefaultDisplayKey(now = new Date()) {
  return getPreviousDisplayKeyFromKey(getLocalTodayKey(now));
}

function getLocalDateKeyFromTimestamp(timestamp) {
  if (!timestamp) return null;
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) return null;
  return formatLocalDateKey(parsed);
}

function getGameDayKeyFromTimestamp(timestamp) {
  const sourceKey = getLocalDateKeyFromTimestamp(timestamp);
  return sourceKey ? getPreviousDisplayKeyFromKey(sourceKey) : null;
}

/**
 * Server-side equivalent of resolveEffectiveGameDayKey.
 * Derives the candidate from the timestamp, then bounds it
 * between previousDisplayKey (today-2) and latestDisplayKey (today-1),
 * both clamped to the same month.
 * Skips localStorage/unlock-cycle logic (not applicable server-side).
 */
function resolveGameDayKey(timestamp, now = new Date()) {
  const latestDisplayKey = getDefaultDisplayKey(now);
  const previousDisplayKey = getPreviousDisplayKeyFromKey(latestDisplayKey);

  const candidateKey = getGameDayKeyFromTimestamp(timestamp);
  const boundedCandidateKey = candidateKey
    ? (candidateKey > latestDisplayKey ? latestDisplayKey
      : candidateKey < previousDisplayKey ? previousDisplayKey
      : candidateKey)
    : null;

  if (boundedCandidateKey === latestDisplayKey || boundedCandidateKey === previousDisplayKey) {
    return boundedCandidateKey;
  }

  return latestDisplayKey;
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

  let updated = 0;

  for (const { id, name, circle } of circleFiles) {
    const rank = circle.monthly_rank;
    const points = circle.monthly_point ?? null;
    const updatedAt = circle.last_updated;

    const dateKey = resolveGameDayKey(updatedAt);
    if (!dateKey) {
      console.warn(`  ⚠  ${name}: could not derive date from last_updated, skipping`);
      continue;
    }

    // Load or initialise this club's history file
    const existing = loadClubHistory(id) || { id, name, history: {} };
    existing.name = name;

    const prev = existing.history[dateKey];

    // Skip if identical data already recorded
    if (prev && prev.rank === rank && prev.points === points) {
      console.log(`  ·  ${name.padEnd(14)} │ ${dateKey} │ rank ${String(rank).padStart(4)} │ (unchanged)`);
      continue;
    }

    const overwrite = !!prev;
    existing.history[dateKey] = {
      rank,
      points,
      recorded_at: new Date().toISOString(),
    };

    saveClubHistory(id, existing);

    const symbol = overwrite ? "↻" : "✓";
    console.log(`  ${symbol}  ${name.padEnd(14)} │ ${dateKey} │ rank ${String(rank).padStart(4)} │ pts ${points ?? "—"}`);
    updated++;
  }

  console.log(`\n${updated > 0 ? `Saved ${updated} update(s)` : "No new updates"} → ${OUTPUT_DIR}`);
}

main();
