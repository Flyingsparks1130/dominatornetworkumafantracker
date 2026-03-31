import fs from "node:fs/promises";
import path from "node:path";

const CONFIG_PATH = path.join(process.cwd(), "scripts", "clubs.config.json");
const DATA_DIR = path.join(process.cwd(), "data");
const API_BASE = "https://uma.moe/api/v4/circles";

function isValidCirclePayload(json) {
  return (
    json &&
    typeof json === "object" &&
    !Array.isArray(json) &&
    json.circle &&
    typeof json.circle === "object" &&
    Array.isArray(json.members)
  );
}

async function fetchClubJson(club) {
  const url = `${API_BASE}?circle_id=${encodeURIComponent(club.id)}`;

  const res = await fetch(url, {
    method: "GET",
    headers: {
      accept: "application/json",
    },
  });

  if (!res.ok) {
    throw new Error(`API request failed for ${club.id}: ${res.status} ${res.statusText}`);
  }

  const text = await res.text();

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`Invalid JSON from API for ${club.id}: ${err.message}`);
  }

  if (!isValidCirclePayload(parsed)) {
    throw new Error(`Unexpected API payload shape for ${club.id}`);
  }

  return parsed;
}

async function saveClubJson(club, payload) {
  const refreshedAt = new Date().toISOString();

  const output = {
    ...payload,
    refreshed_at: refreshedAt,
  };

  const outPath = path.join(DATA_DIR, `${club.id}.json`);
  await fs.writeFile(outPath, JSON.stringify(output, null, 2), "utf8");

  console.log(`✅ SUCCESS: ${club.id} saved (${refreshedAt})`);
}

async function main() {
  const raw = await fs.readFile(CONFIG_PATH, "utf8");
  const clubs = JSON.parse(raw);

  if (!Array.isArray(clubs) || clubs.length === 0) {
    throw new Error("clubs.config.json must contain a non-empty array");
  }

  await fs.mkdir(DATA_DIR, { recursive: true });

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
