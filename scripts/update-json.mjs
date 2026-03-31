import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const CONFIG_PATH = path.join(process.cwd(), "scripts", "clubs.config.json");
const DATA_DIR = path.join(process.cwd(), "data");

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

async function dismissBlockingUi(page) {
  const dismissCandidates = [
    page.getByText("Dismiss", { exact: true }).first(),
    page.getByRole("button", { name: /dismiss/i }).first(),
    page.getByRole("button", { name: /close/i }).first(),
    page.locator("button").filter({ hasText: "Dismiss" }).first(),
    page.locator("button").filter({ hasText: "close" }).first(),
  ];

  for (const locator of dismissCandidates) {
    try {
      if (await locator.count()) {
        await locator.click({ timeout: 3000, force: true });
        await page.waitForTimeout(1000);
        console.log("Dismissed blocking UI");
        return;
      }
    } catch {}
  }

  const backdrop = page.locator(".cdk-overlay-backdrop").first();
  try {
    if (await backdrop.count()) {
      await backdrop.click({ timeout: 3000, force: true });
      await page.waitForTimeout(1000);
      console.log("Clicked overlay backdrop");
    }
  } catch {}
}

async function logButtons(page, clubId) {
  try {
    const buttons = await page.locator("button").allTextContents();
    console.log(`Buttons on ${clubId}:`, buttons);
  } catch {}
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

    await dismissBlockingUi(page);
    await logButtons(page, club.id);

    const exportBtn = page.locator("button").filter({
      hasText: "downloadExportexpand_more",
    }).first();

    if (!(await exportBtn.count())) {
      throw new Error("Export button not found (downloadExportexpand_more)");
    }

    await exportBtn.click({ force: true });
    console.log(`Clicked Export for ${club.id}`);

    await page.waitForTimeout(1500);

    const jsonMenuCandidates = [
      page.getByText("JSON", { exact: true }).first(),
      page.getByRole("menuitem", { name: /json/i }).first(),
      page.locator('[role="menuitem"]').filter({ hasText: "JSON" }).first(),
      page.locator("button").filter({ hasText: "JSON" }).first(),
      page.locator("a").filter({ hasText: "JSON" }).first(),
      page.locator("text=JSON").first(),
    ];

    let jsonClicked = false;
    const downloadPromise = page.waitForEvent("download", { timeout: 60000 });

    for (const locator of jsonMenuCandidates) {
      try {
        if (await locator.count()) {
          await locator.scrollIntoViewIfNeeded();
          await locator.click({ timeout: 5000, force: true });
          jsonClicked = true;
          console.log(`Clicked JSON for ${club.id}`);
          break;
        }
      } catch {}
    }

    if (!jsonClicked) {
      throw new Error("JSON option not found after opening Export menu");
    }

    const download = await downloadPromise;
    const tempPath = await download.path();

    if (!tempPath) {
      throw new Error("Download path missing");
    }

    const text = await fs.readFile(tempPath, "utf8");
    await ensureJson(text, club.id);

    const parsed = JSON.parse(text);
    const refreshedAt = new Date().toISOString();

    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      parsed.refreshed_at = refreshedAt;
    } else {
      throw new Error(`Downloaded JSON for ${club.id} is not an object, cannot add refreshed_at`);
    }

    const outPath = path.join(DATA_DIR, `${club.id}.json`);
    await fs.writeFile(outPath, JSON.stringify(parsed, null, 2), "utf8");

    console.log(`✅ SUCCESS: ${club.id} saved (${refreshedAt})`);
  } finally {
    await page.close();
  }
}

async function main() {
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
