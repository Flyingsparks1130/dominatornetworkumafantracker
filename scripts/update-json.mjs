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
    throw new Error(`Invalid JSON for ${clubId}: ${err.message}`);
  }
}

async function addCookiesIfPresent(page) {
  if (!process.env.DOWNLOAD_COOKIE) return;

  const cookies = process.env.DOWNLOAD_COOKIE
    .split(";")
    .map((c) => c.trim())
    .filter(Boolean)
    .map((pair) => {
      const [name, ...rest] = pair.split("=");
      return {
        name,
        value: rest.join("="),
        domain: "uma.moe",
        path: "/",
      };
    });

  if (cookies.length) {
    await page.context().addCookies(cookies);
  }
}

async function clickFirstVisibleLocator(locators, label) {
  for (const locator of locators) {
    try {
      const count = await locator.count();
      if (!count) continue;

      const first = locator.first();
      await first.scrollIntoViewIfNeeded();
      await first.click({ timeout: 5000 });
      return true;
    } catch {
      // try next
    }
  }

  return false;
}

async function downloadClubJson(browser, club) {
  const page = await browser.newPage();

  try {
    await addCookiesIfPresent(page);

    await page.goto(club.pageUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });

    await page.waitForTimeout(4000);

    const buttons = await page.locator("button").allTextContents();
    console.log(`Buttons on ${club.id}:`, buttons);

    const exportLocators = [
      page.locator('button').filter({ hasText: /Export/i }),
      page.locator('[role="button"]').filter({ hasText: /Export/i }),
      page.getByText(/Export/i),
      page.locator('text=/.*Export.*/i')
    ];

    const exportClicked = await clickFirstVisibleLocator(exportLocators, "Export");

    if (!exportClicked) {
      throw new Error("Export button not found");
    }

    console.log(`Clicked Export for ${club.id}`);
    await page.waitForTimeout(1500);

    const downloadPromise = page.waitForEvent("download", { timeout: 60000 });

    const jsonLocators = [
      page.locator('[role="menuitem"]').filter({ hasText: /JSON/i }),
      page.locator('button').filter({ hasText: /JSON/i }),
      page.locator('a').filter({ hasText: /JSON/i }),
      page.getByText(/JSON/i),
      page.locator('text=/.*JSON.*/i')
    ];

    const jsonClicked = await clickFirstVisibleLocator(jsonLocators, "JSON");

    if (!jsonClicked) {
      throw new Error("JSON option not found");
    }

    console.log(`Clicked JSON for ${club.id}`);

    const download = await downloadPromise;
    const tempPath = await download.path();

    if (!tempPath) {
      throw new Error("Download path missing");
    }

    const text = await fs.readFile(tempPath, "utf8");
    await ensureJson(text, club.id);

    const outPath = path.join(DATA_DIR, `${club.id}.json`);
    await fs.writeFile(outPath, text, "utf8");

    console.log(`✅ SUCCESS: ${club.id} saved`);
  } finally {
    await page.close();
  }
}

async function main() {
  const nyHour = getNewYorkHour();

  if (process.env.GITHUB_EVENT_NAME === "schedule" && nyHour !== 12) {
    console.log(`Skipping run (NY hour ${nyHour})`);
    return;
  }

  const raw = await fs.readFile(CONFIG_PATH, "utf8");
  const clubs = JSON.parse(raw);

  await fs.mkdir(DATA_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: true });

  try {
    for (const club of clubs) {
      console.log(`\n=== Processing ${club.name} (${club.id}) ===`);

      try {
        await downloadClubJson(browser, club);
      } catch (err) {
        console.error(`❌ FAILED: ${club.id}`);
        console.error(err.message);
      }
    }
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error("FATAL ERROR:", err);
  process.exit(1);
});
