import fs from "node:fs/promises";
import path from "node:path";

const CONFIG_PATH = path.join(
  process.cwd(),
  "scripts",
  "chronogenesis.clubs.config.json"
);
const DATA_ROOT = path.join(process.cwd(), "data", "chronogenesis");
const DEBUG_DIR = path.join(process.cwd(), "scripts", "debug");

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36";

function isObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function isValidExportPayload(json) {
  return isObject(json) && Array.isArray(json.members);
}

async function saveDebugResponse(clubId, label, body, contentType = "text/plain") {
  try {
    await fs.mkdir(DEBUG_DIR, { recursive: true });
    const safeLabel = label.replace(/\s+/g, "-").toLowerCase();
    const ext = contentType.includes("json") ? "json" : "txt";
    const outPath = path.join(DEBUG_DIR, `${clubId}-${safeLabel}.${ext}`);
    await fs.writeFile(outPath, body, "utf8");
    console.log(`  📸 Debug saved: scripts/debug/${clubId}-${safeLabel}.${ext}`);
  } catch (err) {
    console.warn("  ⚠️ Could not save debug response:", err.message);
  }
}

async function fetchClubJson(club) {
  if (!club?.id) {
    throw new Error(`Missing id for ${club?.name || "unknown club"}`);
  }

  const apiKey = process.env.CHRONOGENESIS_API_KEY;
  if (!apiKey) {
    throw new Error("Missing CHRONOGENESIS_API_KEY environment variable");
  }

  const apiUrl =
    club.apiUrl ||
    `https://api.chronogenesis.net/club_profile?circle_id=${encodeURIComponent(club.id)}`;

  const headers = {
    Authorization: apiKey,
    "User-Agent": process.env.CHRONOGENESIS_USER_AGENT || DEFAULT_USER_AGENT,
    Accept: "application/json",
  };

  const response = await fetch(apiUrl, {
    method: "GET",
    headers,
  });

  const contentType = response.headers.get("content-type") || "";
  const text = await response.text();

  if (!response.ok) {
    await saveDebugResponse(club.id, `http-${response.status}`, text, contentType);
    throw new Error(`HTTP ${response.status} for ${club.id}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    await saveDebugResponse(club.id, "invalid-json", text, contentType);
    throw new Error(`Response is not valid JSON for ${club.id}: ${err.message}`);
  }

  if (!isValidExportPayload(parsed)) {
    await saveDebugResponse(club.id, "unexpected-shape", text, contentType);
    throw new Error(
      `JSON has unexpected shape for ${club.id}. Top-level keys: ${Object.keys(parsed || {}).join(", ")}`
    );
  }

  return parsed;
}

async function saveClubJson(club, payload) {
  const refreshedAt = new Date().toISOString();

  const output = {
    ...payload,
    refreshed_at: refreshedAt,
    source: "chronogenesis",
    club_id: club.id,
    club_name: club.name ?? null,
  };

  await fs.mkdir(DATA_ROOT, { recursive: true });

  const outPath = path.join(DATA_ROOT, `${club.id}.json`);
  await fs.writeFile(outPath, JSON.stringify(output, null, 2), "utf8");

  console.log(`✅ SUCCESS: ${club.id} saved to data/chronogenesis/${club.id}.json`);
}

async function main() {
  console.log("RUNNING FILE:", import.meta.url);

  const raw = await fs.readFile(CONFIG_PATH, "utf8");
  const clubs = JSON.parse(raw);

  if (!Array.isArray(clubs) || !clubs.length) {
    throw new Error("chronogenesis.clubs.config.json must contain a non-empty array");
  }

  await fs.mkdir(DATA_ROOT, { recursive: true });

  for (const club of clubs) {
    if (!club?.id) {
      console.error("❌ FAILED: missing club id in config entry");
      continue;
    }

    console.log(`\n=== Processing ${club.name || "Unknown"} (${club.id}) ===`);

    try {
      const payload = await fetchClubJson(club);
      await saveClubJson(club, payload);
    } catch (err) {
      console.error(`❌ FAILED: ${club.id}`);
      console.error(err.message);
    }
  }
}

main().catch((err) => {
  console.error("FATAL ERROR:", err);
  process.exit(1);
});
  
    
    

    
          
  

    
  
  