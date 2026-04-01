import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { parse } from "csv-parse/sync";

const CONFIG_PATH = path.join(process.cwd(), "scripts", "chronogenesis.clubs.config.json");
const UMA_REFERENCE_DIR = path.join(process.cwd(), "data");
const CHRONO_DATA_DIR = path.join(process.cwd(), "data", "chronogenesis");

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
        domain: "chronogenesis.net",
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
        console.log("Dismissed blocking UI");
        return;
      }
    } catch {}
  }
}

async function logInteractiveElements(page, clubId) {
  try {
    const buttons = await page.locator("button").allTextContents();
    console.log(`Buttons on ${clubId}:`, buttons);
  } catch {}

  try {
    const links = await page.locator("a").allTextContents();
    console.log(`Links on ${clubId}:`, links.filter(Boolean).slice(0, 50));
  } catch {}

  try {
    const titled = await page.locator("[title], [aria-label]").evaluateAll((els) =>
      els.map((el) => ({
        tag: el.tagName,
        text: (el.innerText || el.textContent || "").trim(),
        title: el.getAttribute("title"),
        aria: el.getAttribute("aria-label"),
        className: el.className || "",
      }))
    );
    console.log(`Title/aria elements on ${clubId}:`, titled);
  } catch {}

  try {
    const roleButtons = await page.locator('[role="button"]').evaluateAll((els) =>
      els.map((el) => ({
        text: (el.innerText || el.textContent || "").trim(),
        aria: el.getAttribute("aria-label"),
        title: el.getAttribute("title"),
        className: el.className || "",
      }))
    );
    console.log(`Role buttons on ${clubId}:`, roleButtons);
  } catch {}

  try {
    const bodyText = await page.locator("body").innerText();
    console.log(`Body text preview on ${clubId}:`, bodyText.slice(0, 2000));
  } catch {}

  try {
    const frames = page.frames().map((f) => f.url());
    console.log(`Frames on ${clubId}:`, frames);
  } catch {}
}

function normalizeViewerId(value) {
  return String(value ?? "").replace(/\D+/g, "").trim();
}

async function downloadChronogenesisCsv(browser, club) {
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await addCookiesIfPresent(context);

    await page.goto(club.pageUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });

    await page.waitForTimeout(5000);
    await dismissBlockingUi(page);

    const exportLocator = page
      .locator('div.save-button.expanded[title="Export as .csv"]')
      .first();

    const pageReadyCandidates = [
      page.locator('text=/Member Cumulative Fan Count/i').first(),
      page.locator('text=/Show active members only/i').first(),
      exportLocator,
      page.locator("select#month").first(),
    ];

    let pageReady = false;
    for (const locator of pageReadyCandidates) {
      try {
        await locator.waitFor({ state: "visible", timeout: 15000 });
        pageReady = true;
        break;
      } catch {}
    }

    await logInteractiveElements(page, club.id);

    if (!pageReady) {
      throw new Error(
        `Chronogenesis club content did not finish loading for ${club.id}. ` +
          `Likely blocked by Cloudflare or delayed app rendering.`
      );
    }

    await exportLocator.scrollIntoViewIfNeeded().catch(() => {});
    await exportLocator.hover({ timeout: 3000 }).catch(() => {});

    const downloadPromise = page.waitForEvent("download", { timeout: 60000 });

    await exportLocator.click({ timeout: 5000, force: true });
    console.log(`Clicked export icon for ${club.id}`);

    const download = await downloadPromise;
    const tempPath = await download.path();

    if (!tempPath) {
      throw new Error(`Download path missing for ${club.id}`);
    }

    const csvText = await fs.readFile(tempPath, "utf8");
    console.log(`Downloaded CSV for ${club.id}, length=${csvText.length}`);
    return csvText;
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
  }
}

function parseChronogenesisCsv(csvText, clubId) {
  const rows = parse(csvText, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  });

  if (!rows.length) {
    throw new Error(`Chronogenesis CSV for ${clubId} was empty`);
  }

  const sampleRow = rows[0];
  const headers = Object.keys(sampleRow);
  const trainerKey = headers.find((h) => String(h).trim().toLowerCase() === "trainer");

  if (!trainerKey) {
    throw new Error(
      `Could not find Trainer column for ${clubId}. Found headers: ${headers.join(", ")}`
    );
  }

  const dayColumns = headers
    .map((header) => {
      const match = String(header).trim().match(/^day\s+(\d+)$/i);
      return match ? { header, day: Number(match[1]) } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.day - b.day);

  if (!dayColumns.length) {
    throw new Error(
      `Could not identify Day N columns for ${clubId}. Found headers: ${headers.join(", ")}`
    );
  }

  return rows.map((row) => {
    const viewerId = normalizeViewerId(row[trainerKey]);

    const dailyFans = dayColumns.map(({ header }) => {
      const raw = String(row[header] ?? "").replace(/,/g, "").trim();
      if (!raw) return 0;
      const n = Number(raw);
      return Number.isFinite(n) ? n : 0;
    });

    return {
      viewer_id: viewerId ? Number(viewerId) : null,
      daily_fans: dailyFans,
    };
  });
}

async function loadUmaReference(circleId) {
  const filePath = path.join(UMA_REFERENCE_DIR, `${circleId}.json`);
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function buildReferenceLookup(referenceJson) {
  const map = new Map();

  if (!referenceJson || !Array.isArray(referenceJson.members)) {
    return map;
  }

  for (const member of referenceJson.members) {
    const viewerId = normalizeViewerId(member.viewer_id);
    if (!viewerId) continue;

    map.set(viewerId, {
      id: member.id ?? null,
      viewer_id: member.viewer_id ?? null,
      trainer_name: member.trainer_name || member.name || null,
      isActive: member.isActive,
      year: member.year ?? null,
      month: member.month ?? null,
    });
  }

  return map;
}

function inferCircleMeta(referenceJson, club, memberCount) {
  const refCircle = referenceJson?.circle || {};

  return {
    circle_id: Number(club.id),
    name: refCircle.name || club.name,
    comment: refCircle.comment ?? null,
    leader_viewer_id: refCircle.leader_viewer_id ?? null,
    leader_name: refCircle.leader_name ?? null,
    member_count: refCircle.member_count ?? memberCount,
    join_style: refCircle.join_style ?? null,
    policy: refCircle.policy ?? null,
    created_at: refCircle.created_at ?? null,
    last_updated: refCircle.last_updated ?? null,
    monthly_rank: refCircle.monthly_rank ?? null,
    monthly_point: refCircle.monthly_point ?? null,
    last_month_rank: refCircle.last_month_rank ?? null,
    last_month_point: refCircle.last_month_point ?? null,
    archived: refCircle.archived ?? false,
    yesterday_updated: refCircle.yesterday_updated ?? null,
    yesterday_points: refCircle.yesterday_points ?? null,
    yesterday_rank: refCircle.yesterday_rank ?? null,
    live_points: refCircle.live_points ?? null,
    live_rank: refCircle.live_rank ?? null,
  };
}

function buildChronogenesisJson(club, csvMembers, referenceJson) {
  const refLookup = buildReferenceLookup(referenceJson);
  const now = new Date();

  let matched = 0;

  const members = csvMembers.map((member) => {
    const key = normalizeViewerId(member.viewer_id);
    const ref = refLookup.get(key);

    if (ref) matched += 1;

    return {
      id: ref?.id ?? null,
      circle_id: Number(club.id),
      viewer_id: member.viewer_id ?? ref?.viewer_id ?? null,
      trainer_name: ref?.trainer_name ?? null,
      year: ref?.year ?? now.getUTCFullYear(),
      month: ref?.month ?? now.getUTCMonth() + 1,
      daily_fans: member.daily_fans,
      isActive: ref?.isActive ?? true,
    };
  });

  return {
    source: "chronogenesis",
    refreshed_at: now.toISOString(),
    circle: inferCircleMeta(referenceJson, club, members.length),
    members,
    meta: {
      matched_members: matched,
      total_members: members.length,
    },
  };
}

async function saveChronogenesisJson(club, payload) {
  const outPath = path.join(CHRONO_DATA_DIR, `${club.id}.json`);
  console.log(`Writing Chronogenesis JSON: ${outPath}`);
  await fs.writeFile(outPath, JSON.stringify(payload, null, 2), "utf8");
  console.log(
    `✅ CHRONO SAVED: ${club.id} matched ${payload.meta?.matched_members ?? 0}/${payload.meta?.total_members ?? 0}`
  );
}

async function processClub(browser, club) {
  if (!club?.id || !club?.pageUrl) {
    throw new Error(`Missing id or pageUrl for club config entry: ${JSON.stringify(club)}`);
  }

  const csvText = await downloadChronogenesisCsv(browser, club);
  const csvMembers = parseChronogenesisCsv(csvText, club.id);
  console.log(`Parsed ${csvMembers.length} Chronogenesis rows for ${club.id}`);
  const referenceJson = await loadUmaReference(club.id);
  const output = buildChronogenesisJson(club, csvMembers, referenceJson);
  await saveChronogenesisJson(club, output);
}

async function main() {
  const raw = await fs.readFile(CONFIG_PATH, "utf8");
  const clubs = JSON.parse(raw);

  if (!Array.isArray(clubs) || !clubs.length) {
    throw new Error("chronogenesis.clubs.config.json must contain a non-empty array");
  }

  await fs.mkdir(CHRONO_DATA_DIR, { recursive: true });

  let successCount = 0;
  const browser = await chromium.launch({ headless: true });

  try {
    for (const club of clubs) {
      console.log(`\n=== Chronogenesis ${club.name || "Unknown"} (${club.id}) ===`);

      try {
        await processClub(browser, club);
        successCount += 1;
      } catch (err) {
        console.error(`❌ CHRONO FAILED: ${club.id}`);
        console.error(err.message);
      }
    }
  } finally {
    await browser.close();
  }

  if (successCount === 0) {
    throw new Error("Chronogenesis refresh finished with 0 successful clubs");
  }
}

main().catch((err) => {
  console.error("FATAL ERROR:", err);
  process.exit(1);
});
