import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const CONFIG_PATH = path.join(process.cwd(), "scripts", "clubs.config.json");
const DATA_DIR = path.join(process.cwd(), "data");

function getNewYorkHour() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    hour12: false,
  }).formatToParts(new Date());

  const hourPart = parts.find(p => p.type === "hour");
  return Number(hourPart?.value ?? "0");
}

async function ensureJson(text, clubId) {
  try {
    JSON.parse(text);
  } catch (err) {
    throw new Error(`Downloaded file for ${clubId} is not valid JSON: ${err.message}`);
  }
}

async function downloadClubJson(browser, club) {
  const page = await browser.newPage();

  if (process.env.DOWNLOAD_COOKIE) {
    const cookiePairs = process.env.DOWNLOAD_COOKIE
      .split(";")
      .map(v => v.trim())
      .filter(Boolean);

    const cookies = cookiePairs.map(pair => {
      const eq = pair.indexOf("=");
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      return {
        name,
        value,
        domain: "uma.moe",
        path: "/",
      };
    });

    if (cookies.length) {
      await page.context().addCookies(cookies);
    }
  }

  await page.goto(club.pageUrl, { waitUntil: "networkidle" });

  const downloadPromise = page.waitForEvent("download", { timeout: 30000 });

  const selectors = [
    'button:has-text("Export")',
    'button:has-text("JSON")',
    'button:has-text("Download")',
    'a:has-text("Export")',
    'a:has-text("JSON")',
    'a:has-text("Download")',
    '[aria-label*="Export"]',
    '[aria-label*="Download"]'
  ];

  let clicked = false;
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.count()) {
      try {
        await locator.click();
        clicked = true;
        break;
      } catch {}
    }
  }

  if (!clicked) {
    throw new Error(`Could not find export/download button for ${club.name}`);
  }

  const download = await downloadPromise;
  const tempPath = await download.path();

  if (!tempPath) {
    throw new Error(`Download failed for ${club.name}`);
  }

  const text = await fs.readFile(tempPath, "utf8");
  await ensureJson(text, club.id);

  const outPath = path.join(DATA_DIR, `${club.id}.json`);
  await fs.writeFile(outPath, text, "utf8");

  console.log(`Saved ${club.id}.json from ${club.pageUrl}`);

  await page.close();
}

async function main() {
  const nyHour = getNewYorkHour();

  if (process.env.GITHUB_EVENT_NAME === "schedule" && nyHour !== 12) {
    console.log(`Skipping run because New York hour is ${nyHour}, not 12.`);
    return;
  }

  const raw = await fs.readFile(CONFIG_PATH, "utf8");
  const clubs = JSON.parse(raw);

  await fs.mkdir(DATA_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: true });

  try {
    for (const club of clubs) {
      await downloadClubJson(browser, club);
    }
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
