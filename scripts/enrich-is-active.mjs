import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const CONFIG_PATH = path.join(process.cwd(), "scripts", "clubs.config.json");
const DATA_DIR = path.join(process.cwd(), "data");

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
        await page.waitForTimeout(800);
        console.log("Dismissed blocking UI");
        return;
      }
    } catch {}
  }

  const backdrop = page.locator(".cdk-overlay-backdrop").first();
  try {
    if (await backdrop.count()) {
      await backdrop.click({ timeout: 3000, force: true });
      await page.waitForTimeout(800);
      console.log("Clicked overlay backdrop");
    }
  } catch {}
}

function inferInactiveFromText(text) {
  const t = String(text || "").toLowerCase();
  return (
    t.includes("inactive") ||
    t.includes("not active") ||
    t.includes("retired") ||
    t.includes("left club") ||
    t.includes("left circle")
  );
}

function inferInactiveFromClassName(className) {
  const c = String(className || "").toLowerCase();
  return (
    c.includes("inactive") ||
    c.includes("disabled") ||
    c.includes("muted") ||
    c.includes("archived")
  );
}

async function extractMemberStatuses(page, club) {
  // Give the list time to render.
  await page.waitForTimeout(2500);

  // Try to switch to list/table view if available.
  const listViewCandidates = [
    page.getByRole("button", { name: /view_list/i }).first(),
    page.locator("button").filter({ hasText: "view_list" }).first(),
  ];

  for (const locator of listViewCandidates) {
    try {
      if (await locator.count()) {
        await locator.click({ timeout: 2000, force: true });
        await page.waitForTimeout(1000);
        break;
      }
    } catch {}
  }

  // Broad candidate selectors to find repeated member rows/cards.
  const rowSelectors = [
    '[data-testid*="member"]',
    '[class*="member"]',
    '[class*="trainer"]',
    'tr',
    '[role="row"]',
    '.mat-mdc-row',
    '.mdc-data-table__row',
    '.ag-row',
    '.v-data-table__tr',
    'li',
  ];

  let extracted = [];

  for (const selector of rowSelectors) {
    try {
      const rows = page.locator(selector);
      const count = await rows.count();
      if (!count) continue;

      const batch = await rows.evaluateAll((els) =>
        els.map((el) => {
          const text = (el.innerText || el.textContent || "").trim();
          const className = el.className || "";
          return { text, className };
        })
      );

      const mapped = batch
        .map((row) => {
          const lines = row.text
            .split("\n")
            .map((v) => v.trim())
            .filter(Boolean);

          if (!lines.length) return null;

          // Heuristic: first short-ish line is usually the trainer name.
          const name =
            lines.find((line) => line.length > 0 && line.length <= 40) || lines[0];

          return {
            name,
            isActive:
              !(inferInactiveFromText(row.text) || inferInactiveFromClassName(row.className)),
            rawText: row.text,
          };
        })
        .filter(Boolean)
        .filter((row) => row.name && row.name.length > 0);

      // Keep the first selector that gives us a plausible member list.
      if (mapped.length >= 10) {
        extracted = mapped;
        break;
      }
    } catch {}
  }

  if (!extracted.length) {
    throw new Error(`Could not extract member statuses from page for ${club.id}`);
  }

  // Deduplicate by normalized name, prefer explicit inactive if seen.
  const byName = new Map();

  for (const row of extracted) {
    const key = normalizeName(row.name);
    if (!key) continue;

    if (!byName.has(key)) {
      byName.set(key, { name: row.name, isActive: row.isActive });
      continue;
    }

    const existing = byName.get(key);
    byName.set(key, {
      name: existing.name,
      isActive: existing.isActive && row.isActive,
    });
  }

  return byName;
}

async function enrichClubJson(browser, club) {
  if (!club?.id || !club?.pageUrl) {
    throw new Error(`Missing id or pageUrl for config entry: ${JSON.stringify(club)}`);
  }

  const outPath = path.join(DATA_DIR, `${club.id}.json`);
  const raw = await fs.readFile(outPath, "utf8");
  const parsed = JSON.parse(raw);

  if (!Array.isArray(parsed.members)) {
    throw new Error(`Saved JSON for ${club.id} does not contain a members array`);
  }

  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await addCookiesIfPresent(context);

    await page.goto(club.pageUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });

    await page.waitForTimeout(3500);
    await dismissBlockingUi(page);

    const statusMap = await extractMemberStatuses(page, club);

    let matched = 0;
    let inactiveCount = 0;

    parsed.members = parsed.members.map((member) => {
      const key = normalizeName(member.trainer_name || member.name);
      const found = statusMap.get(key);

      if (!found) {
        return member;
      }

      matched += 1;
      if (found.isActive === false) inactiveCount += 1;

      return {
        ...member,
        isActive: found.isActive,
      };
    });

    await fs.writeFile(outPath, JSON.stringify(parsed, null, 2), "utf8");

    console.log(
      `✅ ENRICHED: ${club.id} matched ${matched}/${parsed.members.length}, inactive ${inactiveCount}`
    );
  } finally {
    await page.close();
    await context.close();
  }
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
