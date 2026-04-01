import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const CONFIG_PATH = path.join(process.cwd(), "scripts", "clubs.config.json");
const DATA_DIR = path.join(process.cwd(), "data");
const DEBUG_DIR = path.join(process.cwd(), "scripts", "debug");

// Angular Material CDK overlay — all menus render here, outside the main DOM
const CDK_OVERLAY = ".cdk-overlay-container";

// Ordered from most specific to most general — covers both legacy and MDC variants
const MAT_MENU_CONTENT_SELECTORS = [
  ".mat-mdc-menu-content",
  ".mat-menu-content",
  `${CDK_OVERLAY} [role="menu"]`,
  `${CDK_OVERLAY} [role="listbox"]`,
];

function normalizeName(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
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
  const dismissCandidates = [
    page.getByText("Dismiss", { exact: true }).first(),
    page.getByRole("button", { name: /dismiss/i }).first(),
    page.getByRole("button", { name: /close/i }).first(),
    page.locator("button").filter({ hasText: "Dismiss" }).first(),
    page.locator("button").filter({ hasText: /close/i }).first(),
  ];

  for (const locator of dismissCandidates) {
    try {
      if (await locator.count()) {
        await locator.click({ timeout: 3000, force: true });
        await page.waitForTimeout(1000);
        console.log("  Dismissed blocking UI");
        return;
      }
    } catch {}
  }

  const backdrop = page.locator(".cdk-overlay-backdrop").first();
  try {
    if (await backdrop.count()) {
      await backdrop.click({ timeout: 3000, force: true });
      await page.waitForTimeout(1000);
      console.log("  Clicked overlay backdrop");
    }
  } catch {}
}

async function saveDebugSnapshot(page, clubId, label) {
  try {
    await fs.mkdir(DEBUG_DIR, { recursive: true });
    const slug = label.replace(/\s+/g, "-");
    const imgPath = path.join(DEBUG_DIR, `${clubId}-${slug}.png`);
    const htmlPath = path.join(DEBUG_DIR, `${clubId}-${slug}.html`);
    await page.screenshot({ path: imgPath, fullPage: true });
    await fs.writeFile(htmlPath, await page.content(), "utf8");
    console.log(`  📸 Snapshot saved: scripts/debug/${clubId}-${slug}.{png,html}`);
  } catch (e) {
    console.warn("  ⚠️  Could not save debug snapshot:", e.message);
  }
}

/**
 * Wait for an Angular Material (CDK) menu overlay to appear.
 * Returns the selector string of the first match, or null.
 */
async function waitForMatMenu(page) {
  for (const sel of MAT_MENU_CONTENT_SELECTORS) {
    try {
      await page.waitForSelector(sel, { timeout: 5000, state: "visible" });
      console.log(`  ✔ Mat-menu detected: ${sel}`);
      return sel;
    } catch {}
  }
  await page.waitForTimeout(1000);
  return null;
}

/**
 * Log every visible menu item in the CDK overlay to aid debugging.
 */
async function logMenuItems(page) {
  try {
    const items = await page
      .locator(`${CDK_OVERLAY} button, ${CDK_OVERLAY} [role="menuitem"], ${CDK_OVERLAY} a`)
      .allInnerTexts();
    console.log("  Menu items found:", items.map((t) => JSON.stringify(t.trim())).join(", "));
  } catch {}
}

async function downloadPlaywrightJson(browser, club) {
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await addCookiesIfPresent(context);

    await page.goto(club.pageUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });

    await page.waitForTimeout(4000);
    await dismissBlockingUi(page);

    // ── Find and click the Export button ──────────────────────────────────────
    const exportBtn = page.locator("button").filter({
      hasText: "downloadExportexpand_more",
    }).first();

    if (!(await exportBtn.count())) {
      await saveDebugSnapshot(page, club.id, "no-export-btn");
      throw new Error(`Export button not found for ${club.id}`);
    }

    await exportBtn.click({ force: true });

    // ── Wait for the Angular Material CDK menu overlay ────────────────────────
    const menuSel = await waitForMatMenu(page);

    if (!menuSel) {
      await saveDebugSnapshot(page, club.id, "no-menu");
      console.warn(`  ⚠️  Mat-menu not detected for ${club.id} — attempting anyway`);
    }

    await logMenuItems(page);

    // ── Locate the JSON menu item inside the CDK overlay ──────────────────────
    // Angular Material renders mat-menu-items as <button mat-menu-item> inside
    // .mat-mdc-menu-content / .mat-menu-content in the CDK overlay layer.
    const overlay = page.locator(CDK_OVERLAY);

    const jsonMenuCandidates = [
      // MDC variant (Angular 15+)
      overlay.locator(".mat-mdc-menu-item").filter({ hasText: "JSON" }).first(),
      // Legacy variant
      overlay.locator(".mat-menu-item").filter({ hasText: "JSON" }).first(),
      // Generic role-based inside overlay
      overlay.locator('[role="menuitem"]').filter({ hasText: "JSON" }).first(),
      overlay.locator("button").filter({ hasText: "JSON" }).first(),
      overlay.locator("a").filter({ hasText: "JSON" }).first(),
      overlay.locator("li").filter({ hasText: "JSON" }).first(),
      // Last-resort: anywhere on the page
      page.getByRole("menuitem", { name: /^json$/i }).first(),
      page.locator("button, a, li").filter({ hasText: /^JSON$/ }).first(),
    ];

    let jsonClicked = false;

    for (const locator of jsonMenuCandidates) {
      try {
        if (await locator.count()) {
          await locator.scrollIntoViewIfNeeded();

          // Context-level listener so it survives new tabs / page navigation
          const downloadPromise = context.waitForEvent("download", { timeout: 60000 });

          await locator.click({ timeout: 5000, force: true });
          jsonClicked = true;

          const download = await downloadPromise;
          const tempPath = await download.path();

          if (!tempPath) {
            throw new Error(`Download path missing for ${club.id}`);
          }

          const text = await fs.readFile(tempPath, "utf8");
          return JSON.parse(text);
        }
      } catch (err) {
        if (jsonClicked) throw err; // real failure after click
        // locator miss — try next candidate
      }
    }

    await saveDebugSnapshot(page, club.id, "json-not-found");
    throw new Error(`JSON option not found for ${club.id}`);
  } finally {
    await page.close();
    await context.close();
  }
}

async function enrichClubJson(browser, club) {
  if (!club?.id || !club?.pageUrl) {
    throw new Error(`Missing id or pageUrl for ${club.name || "unknown club"}`);
  }

  const apiPath = path.join(DATA_DIR, `${club.id}.json`);
  const apiRaw = await fs.readFile(apiPath, "utf8");
  const apiJson = JSON.parse(apiRaw);

  if (!Array.isArray(apiJson.members)) {
    throw new Error(`API JSON for ${club.id} has no members array`);
  }

  const pwJson = await downloadPlaywrightJson(browser, club);

  if (!Array.isArray(pwJson.members)) {
    throw new Error(`Playwright JSON for ${club.id} has no members array`);
  }

  const isActiveByName = new Map();

  for (const member of pwJson.members) {
    const key = normalizeName(member.name);
    if (!key) continue;
    isActiveByName.set(key, member.isActive !== false);
  }

  let matched = 0;
  let inactive = 0;

  apiJson.members = apiJson.members.map((member) => {
    const key = normalizeName(member.trainer_name);
    if (!isActiveByName.has(key)) {
      return member;
    }

    const isActive = isActiveByName.get(key);
    matched += 1;
    if (isActive === false) inactive += 1;

    return {
      ...member,
      isActive,
    };
  });

  await fs.writeFile(apiPath, JSON.stringify(apiJson, null, 2), "utf8");

  console.log(`✅ ENRICHED: ${club.id} matched ${matched}/${apiJson.members.length}, inactive ${inactive}`);
}

async function main() {
  const raw = await fs.readFile(CONFIG_PATH, "utf8");
  const clubs = JSON.parse(raw);

  if (!Array.isArray(clubs) || !clubs.length) {
    throw new Error("clubs.config.json must contain a non-empty array");
  }

  const browser = await chromium.launch({ headless: true });

  try {
    for (const club of clubs) {
      console.log(`\n=== Enriching ${club.name || "Unknown"} (${club.id}) ===`);

      try {
        await enrichClubJson(browser, club);
      } catch (err) {
        console.error(`❌ ENRICH FAILED: ${club.id}`);
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
