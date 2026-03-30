import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const repoRoot = process.cwd();
const dataDir = path.join(repoRoot, "data");
const configPath = path.join(repoRoot, "scripts", "clubs.config.json");

function nowInNewYork() {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  const parts = Object.fromEntries(
    formatter.formatToParts(new Date()).filter(p => p.type !== "literal").map(p => [p.type, p.value])
  );

  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

function shouldRunAtNoonET() {
  if (process.env.SKIP_TIME_GATE === "1") return true;
  const ny = nowInNewYork();
  return ny.hour === 12;
}

async function readConfig() {
  const raw = await fs.readFile(configPath, "utf8");
  return JSON.parse(raw);
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: {
      Accept: "application/json,text/plain;q=0.9,*/*;q=0.8",
      ...(process.env.DOWNLOAD_AUTH_HEADER
        ? { Authorization: process.env.DOWNLOAD_AUTH_HEADER }
        : {}),
      ...(process.env.DOWNLOAD_COOKIE
        ? { Cookie: process.env.DOWNLOAD_COOKIE }
        : {}),
    },
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}`);
  }

  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Response was not valid JSON. ${error.message}`);
  }
}

async function writeClubFile(id, payload) {
  const outPath = path.join(dataDir, `${id}.json`);
  await fs.writeFile(outPath, JSON.stringify(payload, null, 2) + "\n", "utf8");
  return outPath;
}

async function main() {
  if (!shouldRunAtNoonET()) {
    console.log("Skipping run because it is not 12:xx PM in America/New_York.");
    return;
  }

  const clubs = await readConfig();
  const refreshed = [];
  const skipped = [];

  for (const club of clubs) {
    const url = process.env[club.sourceEnv];
    if (!url) {
      skipped.push(`${club.name} (${club.id}) - missing env ${club.sourceEnv}`);
      continue;
    }

    console.log(`Fetching ${club.name} from ${club.sourceEnv}...`);
    const payload = await fetchJson(url);
    const outPath = await writeClubFile(club.id, payload);
    refreshed.push(`${club.name} -> ${path.relative(repoRoot, outPath)}`);
  }

  if (skipped.length) {
    console.log("Skipped clubs:");
    for (const item of skipped) console.log(`- ${item}`);
  }

  if (!refreshed.length) {
    throw new Error("No club files were refreshed. Add at least one source URL secret.");
  }

  console.log("Refreshed files:");
  for (const item of refreshed) console.log(`- ${item}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
