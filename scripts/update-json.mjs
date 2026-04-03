import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const CONFIG_PATH = path.join(process.cwd(), "scripts", "clubs.config.json");
const DATA_DIR = path.join(process.cwd(), "data");
const DEBUG_DIR = path.join(process.cwd(), "scripts", "debug");

function isValidExportPayload(json) {
  return (
    json &&
    typeof json === "object" &&
    !Array.isArray(json) &&
    Array.isArray(json.members)
  );
}

async function addCookiesIfPresent(context) {
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
    await context.addCookies(cookies);
  }
}

async function dismissBlockingUi(page) {
  const candidates = [
    page.getByRole("button", { name: /accept all/i }).first(),
    page.getByRole("button", { name: /reject all/i }).first(),
    page.getByRole("button", { name: /dismiss/i }).first(),
    page.getByRole("button", { name: /close/i }).first(),
    page.getByText("Dismiss", { exact: true }).first(),
    page.getByText("close", { exact: true }).first(),
    page.locator("button").filter({ hasText: /accept all/i }).first(),
    page.locator("button").filter({ hasText: /reject all/i }).first(),
    page.locator("button").filter({ hasText: /dismiss/i }).first(),
    page.locator("button").filter({ hasText: /close/i }).first(),
  ];

  for (let pass = 0; pass < 5; pass++) {
    let clicked = false;

    for (const locator of candidates) {
      try {
        if (await locator.count()) {
          const visible = await locator.isVisible({ timeout: 500 }).catch(() => false);
          if (visible) {
            await locator.click({ timeout: 2000, force: true });
            await page.waitForTimeout(800);
            clicked = true;
          }
        }
      } catch {}
    }

    try {
      const backdrop = page.locator(".cdk-overlay-backdrop:visible").first();
      if (await backdrop.count()) {
        await backdrop.click({ timeout: 2000, force: true });
        await page.waitForTimeout(500);
        clicked = true;
      }
    } catch {}

    if (!clicked) break;
  }
}

async function saveDebugSnapshot(page, clubId, label) {
  try {
    await fs.mkdir(DEBUG_DIR, { recursive: true });
    const slug = label.replace(/\s+/g, "-");

    await page.screenshot({
      path: path.join(DEBUG_DIR, `${clubId}-${slug}.png`),
      fullPage: true,
    });

    await fs.writeFile(
      path.join(DEBUG_DIR, `${clubId}-${slug}.html`),
      await page.content(),
      "utf8"
    );

    console.log(`  📸 Snapshot: scripts/debug/${clubId}-${slug}.{png,html}`);
  } catch (e) {
    console.warn("  ⚠️ Could not save debug snapshot:", e.message);
  }
}

async function clickExportButton(page) {
  const candidates = [
    page.getByRole("button", { name: /export/i }).first(),
    page.locator("button").filter({ hasText: /export/i }).first(),
    page.locator('[aria-label*="Export" i]').first(),
    page.locator('[mattooltip*="Export" i]').first(),
  ];

  for (const locator of candidates) {
    try {
      if (await locator.count()) {
        await locator.scrollIntoViewIfNeeded().catch(() => {});
        await locator.click({ timeout: 5000, force: true });
        await page.waitForTimeout(1000);
        return true;
      }
    } catch {}
  }

  return false;
}

function buildJsonMenuLocator(page) {
  return page
    .locator(`
      [role="menuitem"],
      [role="option"],
      button,
      a,
      li,
      span,
      div,
      [mat-menu-item],
      .mat-mdc-menu-item,
      .mdc-list-item
    `)
    .filter({ hasText: /\bjson\b/i })
    .first();
}

async function downloadClubJson(browser, club) {
  if (!club?.id || !club?.pageUrl) {
    throw new Error(`Missing id or pageUrl for ${club.name || "unknown club"}`);
  }

  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();

  try {
    await addCookiesIfPresent(context);

    await page.goto(club.pageUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });

    await page.waitForTimeout(4000);
    await dismissBlockingUi(page);

    const clickedExport = await clickExportButton(page);
    if (!clickedExport) {
      await saveDebugSnapshot(page, club.id, "no-export-btn");
      throw new Error(`Export button not found for ${club.id}`);
    }

    const jsonItem = buildJsonMenuLocator(page);

    try {
      await jsonItem.waitFor({ state: "visible", timeout: 8000 });
    } catch {
      const allText = await page
        .locator(
          "button, a, li, [role='menuitem'], [role='option'], [mat-menu-item], .mat-mdc-menu-item, .mdc-list-item"
        )
        .allInnerTexts();

      console.log(
        "  Visible clickables:",
        allText.map((t) => JSON.stringify(t.trim())).join(", ")
      );

      await saveDebugSnapshot(page, club.id, "json-not-visible");
      throw new Error(`JSON option not visible for ${club.id}`);
    }

    const downloadPromise = page.waitForEvent("download", { timeout: 60000 });
    await jsonItem.click({ timeout: 5000, force: true });

    const download = await downloadPromise;
    const tempPath = await download.path();

    if (!tempPath) {
      throw new Error(`Download path missing for ${club.id}`);
    }

    const text = await fs.readFile(tempPath, "utf8");

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new Error(`Downloaded file is not valid JSON for ${club.id}: ${err.message}`);
    }

    if (!isValidExportPayload(parsed)) {
      throw new Error(
        `Downloaded JSON has unexpected shape for ${club.id}. ` +
        `Top-level keys: ${Object.keys(parsed || {}).join(", ")}`
      );
    }

    return parsed;
  } finally {
    await page.close();
    await context.close();
  }
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
  console.log("RUNNING FILE:", import.meta.url);

  const raw = await fs.readFile(CONFIG_PATH, "utf8");
  const clubs = JSON.parse(raw);

  if (!Array.isArray(clubs) || !clubs.length) {
    throw new Error("clubs.config.json must contain a non-empty array");
  }

  await fs.mkdir(DATA_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: true });

  try {
    for (const club of clubs) {
      if (!club?.id) {
        console.error("❌ FAILED: missing club id in config entry");
        continue;
      }

      console.log(`\n=== Processing ${club.name || "Unknown"} (${club.id}) ===`);

      try {
        const payload = await downloadClubJson(browser, club);
        await saveClubJson(club, payload);
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
