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
const configuredMaxAttempts = Number(process.env.CHRONOGENESIS_MAX_ATTEMPTS || 4);
const configuredRetryBaseMs = Number(
  process.env.CHRONOGENESIS_RETRY_BASE_MS || 5_000
);
const MAX_ATTEMPTS = Number.isFinite(configuredMaxAttempts)
  ? Math.min(8, Math.max(1, Math.floor(configuredMaxAttempts)))
  : 4;
const RETRY_BASE_MS = Number.isFinite(configuredRetryBaseMs)
  ? Math.max(1_000, configuredRetryBaseMs)
  : 5_000;

function isObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function parseRetryAfter(value) {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);

  const retryAt = Date.parse(value);
  return Number.isFinite(retryAt) ? Math.max(0, retryAt - Date.now()) : 0;
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

async function clearDebugResponses(clubId) {
  try {
    const entries = await fs.readdir(DEBUG_DIR);
    const prefix = `${clubId}-`;
    await Promise.all(
      entries
        .filter((entry) => entry.startsWith(prefix))
        .map((entry) => fs.unlink(path.join(DEBUG_DIR, entry)))
    );
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.warn(`  ⚠️ Could not clear old debug responses for ${clubId}: ${err.message}`);
    }
  }
}

async function fetchClubJsonOnce(club) {
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

  let response;
  try {
    response = await fetch(apiUrl, {
      method: "GET",
      headers,
    });
  } catch (err) {
    err.retryable = true;
    throw err;
  }

  const contentType = response.headers.get("content-type") || "";
  const text = await response.text();

  if (!response.ok) {
    await saveDebugResponse(club.id, `http-${response.status}`, text, contentType);
    const error = new Error(`HTTP ${response.status} for ${club.id}`);
    error.status = response.status;
    error.retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
    error.retryable =
      response.status === 408 ||
      response.status === 429 ||
      response.status >= 500 ||
      (response.status === 403 && /cloudflare|rate.?limit|temporar/i.test(text));
    throw error;
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    await saveDebugResponse(club.id, "invalid-json", text, contentType);
    const parseError = new Error(
      `Response is not valid JSON for ${club.id}: ${err.message}`
    );
    parseError.retryable = true;
    throw parseError;
  }

  if (!isObject(parsed)) {
    await saveDebugResponse(club.id, "unexpected-shape", text, contentType);
    const shapeError = new Error(`Response is not a JSON object for ${club.id}`);
    shapeError.retryable = true;
    throw shapeError;
  }

  return parsed;
}

async function fetchClubJson(club) {
  let lastError;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const payload = await fetchClubJsonOnce(club);
      await clearDebugResponses(club.id);
      return payload;
    } catch (err) {
      lastError = err;
      if (!err.retryable || attempt === MAX_ATTEMPTS) break;

      const delayMs = Math.min(
        60_000,
        Math.max(err.retryAfterMs || 0, RETRY_BASE_MS * 2 ** (attempt - 1))
      );
      console.warn(
        `  ⚠️ Attempt ${attempt}/${MAX_ATTEMPTS} failed for ${club.id}: ` +
        `${err.message}. Retrying in ${Math.ceil(delayMs / 1_000)}s.`
      );
      await sleep(delayMs);
    }
  }

  throw lastError;
}

async function saveClubJson(club, payload) {
  await fs.mkdir(DATA_ROOT, { recursive: true });

  const outPath = path.join(DATA_ROOT, `${club.id}.json`);
  await fs.writeFile(outPath, JSON.stringify(payload, null, 2), "utf8");

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
  const failures = [];

  for (const club of clubs) {
    if (!club?.id) {
      console.error("❌ FAILED: missing club id in config entry");
      failures.push({ id: "unknown", message: "missing club id in config entry" });
      continue;
    }

    console.log(`\n=== Processing ${club.name || "Unknown"} (${club.id}) ===`);

    try {
      const payload = await fetchClubJson(club);
      await saveClubJson(club, payload);
    } catch (err) {
      console.error(`❌ FAILED: ${club.id}`);
      console.error(err.message);
      failures.push({ id: String(club.id), message: err.message });
    }
  }

  if (failures.length) {
    throw new Error(
      `${failures.length} club update(s) failed: ` +
      failures.map((failure) => `${failure.id} (${failure.message})`).join(", ")
    );
  }
}

main().catch((err) => {
  console.error("FATAL ERROR:", err);
  process.exit(1);
});
