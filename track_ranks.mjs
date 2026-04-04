#!/usr/bin/env node
/**
 * Dominator Rank History Tracker
 *
 * Scans data/ for circle JSON files, extracts `yesterday_rank`,
 * and appends to a history file keyed by the effective game day
 * derived from `yesterday_updated` (same date logic as the app).
 *
 * Usage:
 *   node scripts/track_ranks.js
 *
 * Reads:   data/*.json  (circle data files)
 * Writes:  data/club_rank_history/rank_history.json
 *
 * Exit codes:
 *   0 = success (updates written or nothing new)
 *   1 = no valid circle data found (signals upstream failure)
 */

const fs = require("fs");
const path = require("path");

// ── Config ─────────────────────────────────────────────────────────────

const DATA_DIR = path.resolve(__dirname, "..", "data");
const CLUBS_FILE = path.join(DATA_DIR, "clubs.json"); // optional manifest
const HISTORY_DIR = path.join(DATA_DIR, "club_rank_history");
const HISTORY_FILE = path.join(HISTORY_DIR, "rank_history.json");

// ── Date logic (mirrors the app's effective-game-day derivation) ──────

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

function shiftDateKeyWithinSameMonth(key, deltaDays) {
  if (!isDateKey(key)) return key;
  const shifted = shiftDateKey(key, deltaDays);
  return shifted.slice(0, 7) === key.slice(0, 7) ? shifted : key;
}

function getPreviousDisplayKeyFromKey(key) {
  return shiftDateKeyWithinSameMonth(key, -1);
}

function getLocalDateKeyFromTimestamp(timestamp) {
  if (!timestamp) return null;
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) return null;
  return formatLocalDateKey(parsed);
}

/**
 * yesterday_updated "2026-04-03T06:51:23Z"
 *   → local date "2026-04-03"
 *   → shift back 1 day → "2026-04-02"  (the actual game day)
 */
function getGameDayKeyFromTimestamp(timestamp) {
  const sourceKey = getLocalDateKeyFromTimestamp(timestamp);
  return sourceKey ? getPreviousDisplayKeyFromKey(sourceKey) : null;
}

// ── History I/O ────────────────────────────────────────────────────────

function loadHistory() {
  try {
    return JSON.parse(fs.readFileSync(HISTORY_FILE, "utf-8"));
  } catch {
    return {};
  }
}

function saveHistory(history) {
  fs.mkdirSync(HISTORY_DIR, { recursive: true });
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2) + "\n", "utf-8");
}

// ── Find circle data files ────────────────────────────────────────────

function getClubIds() {
  // If a clubs manifest exists, use it to know which IDs to look for
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
    if (file === "rank_history.json" || file === "clubs.json") continue;

    const filePath = path.join(DATA_DIR, file);
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      const circle = raw.circle || raw;

      // Must have the fields we need
      if (!circle.circle_id || circle.yesterday_rank == null) continue;

      const id = String(circle.circle_id);

      // If we have a manifest, only process listed clubs
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
  console.log(`Data dir:    ${DATA_DIR}`);
  console.log(`History:     ${HISTORY_FILE}\n`);

  const circleFiles = findCircleFiles();

  if (circleFiles.length === 0) {
    console.error("No valid circle data files found in data/. Aborting.");
    process.exit(1);
  }

  const history = loadHistory();
  let updated = 0;

  for (const { id, name, circle, file } of circleFiles) {
    const rank = circle.yesterday_rank;
    const points = circle.yesterday_points ?? null;
    const updatedAt = circle.yesterday_updated;

    const gameDayKey = getGameDayKeyFromTimestamp(updatedAt);
    if (!gameDayKey) {
      console.warn(`  ⚠  ${name} (${file}): could not derive game day from yesterday_updated, skipping`);
      continue;
    }

    if (!history[id]) {
      history[id] = { name, history: {} };
    }
    history[id].name = name;

    const existed = !!history[id].history[gameDayKey];
    const prev = history[id].history[gameDayKey];

    // Skip if identical data already recorded
    if (prev && prev.rank === rank && prev.points === points) {
      console.log(`  ·  ${name.padEnd(14)} │ ${gameDayKey} │ rank ${String(rank).padStart(4)} │ (unchanged)`);
      continue;
    }

    history[id].history[gameDayKey] = {
      rank,
      points,
      recorded_at: new Date().toISOString(),
    };

    const symbol = existed ? "↻" : "✓";
    console.log(`  ${symbol}  ${name.padEnd(14)} │ ${gameDayKey} │ rank ${String(rank).padStart(4)} │ pts ${points ?? "—"}`);
    updated++;
  }

  if (updated > 0) {
    saveHistory(history);
    console.log(`\nSaved ${updated} update(s) → ${HISTORY_FILE}`);
  } else {
    console.log("\nNo new updates to save.");
  }
}

main();
