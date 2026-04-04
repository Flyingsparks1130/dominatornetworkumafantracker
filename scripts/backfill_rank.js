#!/usr/bin/env node
/**
 * Backfill a rank entry into a club's history file.
 *
 * Usage:
 *   node scripts/backfill_rank.js <circle_id> <date> <rank> <points>
 *
 * Examples:
 *   node scripts/backfill_rank.js 114037107 2026-04-03 166 141088981
 *   node scripts/backfill_rank.js 114037107 2026-04-02 180 95000000
 *   node scripts/backfill_rank.js 114037107 2026-04-01 200 42000000
 */

const fs = require("fs");
const path = require("path");

const OUTPUT_DIR = path.resolve(__dirname, "..", "data", "club_rank_history");

const [circleId, date, rankStr, pointsStr] = process.argv.slice(2);

if (!circleId || !date || !rankStr) {
  console.log("Usage: node scripts/backfill_rank.js <circle_id> <date> <rank> [points]");
  console.log("  e.g. node scripts/backfill_rank.js 114037107 2026-04-03 166 141088981");
  process.exit(1);
}

const rank = Number(rankStr);
const points = pointsStr != null ? Number(pointsStr) : null;
const filePath = path.join(OUTPUT_DIR, `${circleId}.json`);

let data;
try {
  data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
} catch {
  console.error(`No history file found at ${filePath}`);
  console.error("Run track_ranks.js first, or provide a valid circle_id.");
  process.exit(1);
}

const existed = !!data.history[date];
data.history[date] = {
  rank,
  points,
  recorded_at: new Date().toISOString(),
};

// Sort history keys chronologically
const sorted = {};
for (const key of Object.keys(data.history).sort()) {
  sorted[key] = data.history[key];
}
data.history = sorted;

fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf-8");

const symbol = existed ? "↻ Overwrote" : "✓ Added";
console.log(`${symbol}  ${data.name} │ ${date} │ rank ${rank} │ pts ${points ?? "—"}`);
