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

  const hourPart = parts.find((p) => p.type === "hour");
  return Number(hourPart?.value ?? "0");
}

async function ensureJson(text, clubId) {
  try {
    JSON.parse(text);
  } catch (err) {
    throw new Error(`Downloaded file for ${clubId} is not valid JSON: ${err.message}`);
  }
}

async function addCookiesIfPresent(page) {
  if (!process.env.DOWNLOAD_COOKIE) return;

  const cookiePairs = process.env.DOWNLOAD_COOKIE
    .split(";")
    .map((v) => v.trim())
    .filter(Boolean);

  const cookies = cookiePairs
    .map((pair) => {
      const eq = pair.indexOf("=");
      if (eq <= 0) return null;

      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();

      if (!name) return null;

      return {
        name,
        value,
        domain: "uma.moe",
        path: "/",
      };
    })
    .filter(Boolean);

  if (cookies.length) {
    await page.context().addCookies(cookies);
  }
}

async function clickFirstMatching(page, selectors) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    const count = await locator.count();

    if (!count) continue;

    try {
      await locator.scrollIntoViewIfNeeded();
      await locator.click({ timeout: 5000 });
      return selector;
    } catch {
      // try next selector
    }
  }

  return null;
}

async function downloadClubJson(browser, club) {
  const page = await browser.newPage();

  try {
    await addCookiesIfPresent(page);

    await page.goto(club.pageUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });

    await page.waitForTimeout(3000);

    const exportSelectors = [
      'button:has-text("Export")',
      'a:has-text("Export")',
      '[aria-label*="Export"]',
      '[title*="Export"]',
      'text=Export'
    ];

    const exportClicked = await clickFirstMatching(page, exportSelectors);

    if (!exportClicked) {
      throw new Error(`Could not find Export button for ${club.name}`);
    }

    console.log(`Clicked Export for ${club.id} using ${exportClicked}`);

    await page.waitForTimeout(1500);

    const downloadPromise = page.waitForEvent("download", { timeout: 60000 });

    const jsonSelectors = [
      'button:has-text("JSON")',
      'a:has-text("JSON")',
      '[role="menuitem"]:has-text("JSON")',
      'text=JSON'
    ];

    const jsonClicked = await clickFirstMatching(page, jsonSelectors);

    if (!jsonClicked) {
      throw new Error(`Could not find JSON option for ${club.name}`);
    }

    console.log(`Clicked JSON for ${club.id} using ${jsonClicked}`);

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
  } finally {
    await page.close();
  }
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
      if (!club?.id || !club?.pageUrl) {
        console.warn("Skipping invalid club entry:", club);
        continue;
      }

      console.log(`Processing ${club.name} (${club.id})`);
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
