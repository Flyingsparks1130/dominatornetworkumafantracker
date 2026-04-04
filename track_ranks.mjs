#!/usr/bin/env node
/**
 * Dominator Rank History Tracker
 *
 * Reads club JSON files, extracts `yesterday_rank`, and appends
 * to a history file keyed by the effective game day derived from
 * the `yesterday_updated` timestamp (using the same date logic
 * as the main app).
 *
 * Usage:
 *   node track_ranks.js <club_json_path> [history_json_path]
 *   node track_ranks.js ./clubs/*.json              # process multiple files
 *
 * History format (rank_history.json):
 * {
 *   "114037107": {                    // circle_id
 *     "name": "Dominator",
 *     "history": {
 *       "2026-04-02": { "rank": 406, "points": 53085835, "recorded_at": "2026-04-04T..." },
 *       "2026-04-01": { "rank": 312, "points": 61000000, "recorded_at": "2026-04-03T..." }
 *     }
 *   }
 * }
 */

const fs = require("fs");
const path = require("path");

// ── Date logic (mirrors the app's effective-game-day logic) ────────────

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
 * Core logic: derive the effective game-day key from the
 * `yesterday_updated` timestamp on the circle object.
 *
 * yesterday_updated "2026-04-03T06:51:23Z"
 *   → local date key  "2026-04-03"  (or "2026-04-02" depending on tz offset)
 *   → shift back 1 day → "2026-04-02"
 *
 * This is the date the rank actually represents.
 */
function getGameDayKeyFromTimestamp(timestamp) {
  const sourceKey = getLocalDateKeyFromTimestamp(timestamp);
  return sourceKey ? getPreviousDisplayKeyFromKey(sourceKey) : null;
}

// ── History file I/O ───────────────────────────────────────────────────

const DEFAULT_HISTORY_PATH = path.resolve("rank_history.json");

function loadHistory(historyPath) {
  try {
    return JSON.parse(fs.readFileSync(historyPath, "utf-8"));
  } catch {
    return {};
  }
}

function saveHistory(history, historyPath) {
  fs.writeFileSync(historyPath, JSON.stringify(history, null, 2) + "\n", "utf-8");
}

// ── Main processing ────────────────────────────────────────────────────

function processClubJson(filePath, history) {
  const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));

  // Support both bare circle objects and wrapper objects with a `circle` key
  const circle = raw.circle || raw;

  const circleId = String(circle.circle_id);
  const name = circle.name || circleId;
  const rank = circle.yesterday_rank;
  const points = circle.yesterday_points ?? null;
  const updatedAt = circle.yesterday_updated;

  if (rank == null) {
    console.warn(`  ⚠  ${name}: no yesterday_rank found, skipping`);
    return null;
  }

  const gameDayKey = getGameDayKeyFromTimestamp(updatedAt);
  if (!gameDayKey) {
    console.warn(`  ⚠  ${name}: could not derive game day from yesterday_updated (${updatedAt}), skipping`);
    return null;
  }

  // Ensure club entry exists
  if (!history[circleId]) {
    history[circleId] = { name, history: {} };
  }
  history[circleId].name = name; // keep name fresh

  const alreadyExists = !!history[circleId].history[gameDayKey];
  history[circleId].history[gameDayKey] = {
    rank,
    points,
    recorded_at: new Date().toISOString(),
  };

  console.log(
    `  ${alreadyExists ? "↻" : "✓"}  ${name} │ ${gameDayKey} │ rank ${rank} │ pts ${points ?? "—"}`
  );

  return gameDayKey;
}

// ── CLI entry point ────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.log("Usage: node track_ranks.js <club.json> [club2.json ...] [--history path/to/history.json]");
    process.exit(1);
  }

  // Parse --history flag
  let historyPath = DEFAULT_HISTORY_PATH;
  const jsonFiles = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--history" && args[i + 1]) {
      historyPath = path.resolve(args[++i]);
    } else {
      jsonFiles.push(args[i]);
    }
  }

  console.log(`History file: ${historyPath}\n`);
  const history = loadHistory(historyPath);

  let updated = 0;
  for (const file of jsonFiles) {
    try {
      const result = processClubJson(path.resolve(file), history);
      if (result) updated++;
    } catch (err) {
      console.error(`  ✗  Error processing ${file}: ${err.message}`);
    }
  }

  if (updated > 0) {
    saveHistory(history, historyPath);
    console.log(`\nSaved ${updated} update(s) → ${historyPath}`);
  } else {
    console.log("\nNo updates to save.");
  }
}

main();
