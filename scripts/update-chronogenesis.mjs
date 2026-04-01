import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { parse } from "csv-parse/sync";

// Apply stealth patches — hides navigator.webdriver, plugin/mimeType
// fingerprints, WebGL vendor, Chrome runtime checks, etc.
chromium.use(StealthPlugin());

const CONFIG_PATH = path.join(process.cwd(), "scripts", "chronogenesis.clubs.config.json");
const UMA_REFERENCE_DIR = path.join(process.cwd(), "data");
const CHRONO_DATA_DIR = path.join(process.cwd(), "data", "chronogenesis");

async function addCookiesIfPresent(context) {
  const raw = (process.env.DOWNLOAD_COOKIE || "").trim();
  if (!raw) return;

  const cookies = raw
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const eq = part.indexOf("=");
      if (eq <= 0) return null;

      const name = part.slice(0, eq).trim();
      const value = part.slice(eq + 1).trim();

      if (!name || !value) return null;

      return {
        name,
        value,
        url: "https://chronogenesis.net",
      };
    })
    .filter(Boolean);

  if (!cookies.length) {
    throw new Error("DOWNLOAD_COOKIE did not contain any valid name=value cookies");
  }

  await context.addCookies(cookies);
  console.log(`Injected ${cookies.length} cookie(s) for chronogenesis.net`);
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

function isLikelyStructuredData(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function searchObjectForMemberData(root, seen = new WeakSet(), pathName = "root", hits = []) {
  if (!root || typeof root !== "object") return hits;
  if (seen.has(root)) return hits;
  seen.add(root);

  try {
    if (Array.isArray(root)) {
      if (
        root.length &&
        root.some(
          (item) =>
            item &&
            typeof item === "object" &&
            (
              "viewer_id" in item ||
              "trainer_name" in item ||
              "daily_fans" in item ||
              "name" in item
            )
        )
      ) {
        hits.push({ path: pathName, value: root });
      }

      for (let i = 0; i < root.length; i++) {
        searchObjectForMemberData(root[i], seen, `${pathName}[${i}]`, hits);
      }
      return hits;
    }

    const keys = Object.keys(root);

    if (
      ("members" in root && Array.isArray(root.members)) ||
      ("datasets" in root && Array.isArray(root.datasets)) ||
      ("series" in root && Array.isArray(root.series))
    ) {
      hits.push({ path: pathName, value: root });
    }

    for (const key of keys) {
      const child = root[key];
      searchObjectForMemberData(child, seen, `${pathName}.${key}`, hits);
    }
  } catch {}

  return hits;
}

function normalizeChronoMembersFromJson(payload, clubId) {
  if (!payload) return null;

  const candidateArrays = [];

  if (Array.isArray(payload)) candidateArrays.push(payload);
  if (Array.isArray(payload.members)) candidateArrays.push(payload.members);
  if (Array.isArray(payload.data?.members)) candidateArrays.push(payload.data.members);
  if (Array.isArray(payload.trainers)) candidateArrays.push(payload.trainers);
  if (Array.isArray(payload.data?.trainers)) candidateArrays.push(payload.data.trainers);
  if (Array.isArray(payload.series)) candidateArrays.push(payload.series);

  for (const arr of candidateArrays) {
    const normalized = arr
      .map((item) => {
        if (!item || typeof item !== "object") return null;

        const viewerId =
          item.viewer_id ??
          item.trainer_id ??
          item.member_id ??
          item.trainer ??
          item.id ??
          null;

        const dailyFans =
          Array.isArray(item.daily_fans)
            ? item.daily_fans
            : Array.isArray(item.data)
            ? item.data
            : Array.isArray(item.values)
            ? item.values
            : null;

        if (!dailyFans || !Array.isArray(dailyFans)) return null;

        return {
          viewer_id: normalizeViewerId(viewerId) ? Number(normalizeViewerId(viewerId)) : null,
          trainer_name: item.trainer_name || item.name || null,
          daily_fans: dailyFans.map((v) => (Number.isFinite(Number(v)) ? Number(v) : 0)),
        };
      })
      .filter(Boolean);

    if (normalized.length) {
      console.log(`Normalized ${normalized.length} member rows from JSON/object for ${clubId}`);
      return normalized;
    }
  }

  return null;
}

async function tryCaptureNetworkData(page, clubId) {
  const captured = [];
  const allResponses = []; // log EVERY response for debugging

  page.on("response", async (response) => {
    try {
      const url = response.url();
      const status = response.status();
      const headers = response.headers();
      const contentType = headers["content-type"] || "";
      const requestType = response.request().resourceType();

      // Log every non-image/font/stylesheet response for debugging
      if (!["image", "font", "stylesheet"].includes(requestType)) {
        allResponses.push({ url: url.slice(0, 200), status, contentType, requestType });
      }

      if (
        !(
          contentType.includes("application/json") ||
          contentType.includes("text/csv") ||
          contentType.includes("text/plain") ||
          requestType === "xhr" ||
          requestType === "fetch"
        )
      ) {
        return;
      }

      const text = await response.text();

      captured.push({
        url,
        contentType,
        status,
        requestType,
        text,
      });
    } catch {}
  });

  await page.waitForTimeout(5000);

  // ── Verbose debug dump ──────────────────────────────────────────────
  console.log(`\n─── Network debug for ${clubId} ───`);
  console.log(`Total non-asset responses: ${allResponses.length}`);
  for (const r of allResponses) {
    console.log(`  [${r.status}] ${r.requestType.padEnd(10)} ${r.contentType.slice(0, 40).padEnd(42)} ${r.url}`);
  }

  console.log(`\nCaptured ${captured.length} candidate response(s) for ${clubId}`);
  for (const item of captured) {
    const preview = item.text.slice(0, 300).replace(/\n/g, "\\n");
    console.log(`  [${item.status}] ${item.url.slice(0, 120)}`);
    console.log(`         type=${item.contentType}  body=${preview}`);
  }
  console.log(`─── End network debug ───\n`);
  // ────────────────────────────────────────────────────────────────────

  for (const item of captured) {
    try {
      if (item.contentType.includes("text/csv")) {
        console.log(`Found CSV network response for ${clubId}: ${item.url}`);
        return { type: "csv", payload: item.text, sourceUrl: item.url };
      }

      const parsed = JSON.parse(item.text);
      const normalized = normalizeChronoMembersFromJson(parsed, clubId);

      if (normalized?.length) {
        console.log(`Found JSON/XHR member data for ${clubId}: ${item.url}`);
        return { type: "members", payload: normalized, sourceUrl: item.url };
      }
    } catch {}
  }

  return null;
}

async function tryExtractFromPageState(page, clubId) {
  const result = await page.evaluate(() => {
    function isObject(value) {
      return value && typeof value === "object";
    }

    function collectCandidates() {
      const found = [];
      const seen = new WeakSet();

      function walk(value, path) {
        if (!isObject(value)) return;
        if (seen.has(value)) return;
        seen.add(value);

        try {
          if (Array.isArray(value)) {
            if (
              value.length &&
              value.some(
                (item) =>
                  isObject(item) &&
                  (
                    "viewer_id" in item ||
                    "trainer_name" in item ||
                    "daily_fans" in item ||
                    "name" in item ||
                    "data" in item
                  )
              )
            ) {
              found.push({ path, value });
            }

            for (let i = 0; i < value.length; i++) {
              walk(value[i], `${path}[${i}]`);
            }
            return;
          }

          if (
            ("members" in value && Array.isArray(value.members)) ||
            ("trainers" in value && Array.isArray(value.trainers)) ||
            ("series" in value && Array.isArray(value.series)) ||
            ("datasets" in value && Array.isArray(value.datasets))
          ) {
            found.push({ path, value });
          }

          for (const key of Object.keys(value)) {
            walk(value[key], `${path}.${key}`);
          }
        } catch {}
      }

      for (const key of Object.keys(window)) {
        try {
          walk(window[key], `window.${key}`);
        } catch {}
      }

      return found.slice(0, 50);
    }

    return collectCandidates();
  });

  console.log(`Found ${result.length} page-state candidate object(s) for ${clubId}`);
  for (const item of result.slice(0, 10)) {
    console.log(`Page-state candidate on ${clubId}: ${item.path}`);
  }

  for (const item of result) {
    const normalized = normalizeChronoMembersFromJson(item.value, clubId);
    if (normalized?.length) {
      console.log(`Using page-state object ${item.path} for ${clubId}`);
      return { type: "members", payload: normalized, sourcePath: item.path };
    }
  }

  return null;
}

async function downloadChronogenesisCsv(page, clubId) {
  const exportLocator = page
    .locator('div.save-button.expanded[title="Export as .csv"]')
    .first();

  await exportLocator.waitFor({ state: "visible", timeout: 15000 });
  await exportLocator.scrollIntoViewIfNeeded().catch(() => {});
  await exportLocator.hover({ timeout: 3000 }).catch(() => {});

  const downloadPromise = page.waitForEvent("download", { timeout: 60000 });

  await exportLocator.click({ timeout: 5000, force: true });
  console.log(`Clicked export icon for ${clubId}`);

  const download = await downloadPromise;
  const tempPath = await download.path();

  if (!tempPath) {
    throw new Error(`Download path missing for ${clubId}`);
  }

  const csvText = await fs.readFile(tempPath, "utf8");
  console.log(`Downloaded CSV for ${clubId}, length=${csvText.length}`);
  return csvText;
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
      trainer_name: null,
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

function buildChronogenesisJson(club, sourceMembers, referenceJson) {
  const refLookup = buildReferenceLookup(referenceJson);
  const now = new Date();

  let matched = 0;

  const members = sourceMembers.map((member) => {
    const key = normalizeViewerId(member.viewer_id);
    const ref = refLookup.get(key);

    if (ref) matched += 1;

    return {
      id: ref?.id ?? null,
      circle_id: Number(club.id),
      viewer_id: member.viewer_id ?? ref?.viewer_id ?? null,
      trainer_name: ref?.trainer_name ?? member.trainer_name ?? null,
      year: ref?.year ?? now.getUTCFullYear(),
      month: ref?.month ?? now.getUTCMonth() + 1,
      daily_fans: Array.isArray(member.daily_fans) ? member.daily_fans : [],
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

async function getChronogenesisMembers(browser, club) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
    locale: "en-US",
    timezoneId: "America/New_York",
  });

  // Patch webdriver flag and add realistic browser properties before any page loads
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
    Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
    Object.defineProperty(navigator, "plugins", {
      get: () => [1, 2, 3, 4, 5], // non-empty array passes simple length checks
    });

    // Patch chrome runtime to look like a real browser
    window.chrome = {
      runtime: {},
      loadTimes: function () {},
      csi: function () {},
      app: { isInstalled: false },
    };

    // Override permissions query to report "prompt" (real browser default)
    const originalQuery = window.navigator.permissions?.query;
    if (originalQuery) {
      window.navigator.permissions.query = (parameters) =>
        parameters.name === "notifications"
          ? Promise.resolve({ state: Notification.permission })
          : originalQuery(parameters);
    }
  });

  const page = await context.newPage();

  try {
    await addCookiesIfPresent(context);

    const networkPromise = tryCaptureNetworkData(page, club.id);

    await page.goto(club.pageUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });

    // Wait for Cloudflare Turnstile challenge to resolve, then extra settle time
    console.log(`Waiting for Turnstile / page content to settle for ${club.id}...`);
    await page
      .waitForFunction(
        () => {
          // Turnstile injects a hidden input with cf-turnstile-response when solved
          const solved = document.querySelector('input[name="cf-turnstile-response"]');
          // Or just check if the real page content has loaded (e.g. chart/table/export)
          const hasContent =
            document.querySelector(".save-button") ||
            document.querySelector("canvas") ||
            document.querySelector("table") ||
            document.querySelector(".chart-container");
          return solved || hasContent;
        },
        { timeout: 30000 }
      )
      .catch(() => console.log(`Turnstile/content wait timed out for ${club.id}, continuing...`));

    await page.waitForTimeout(5000);
    await dismissBlockingUi(page);
    await logInteractiveElements(page, club.id);

    // ── Debug: screenshot + HTML dump ─────────────────────────────────
    try {
      const screenshotPath = path.join(CHRONO_DATA_DIR, `debug-${club.id}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: true });
      console.log(`Debug screenshot saved: ${screenshotPath}`);
    } catch (e) { console.log(`Screenshot failed: ${e.message}`); }

    try {
      const html = await page.content();
      const htmlPath = path.join(CHRONO_DATA_DIR, `debug-${club.id}.html`);
      await fs.writeFile(htmlPath, html, "utf8");
      console.log(`Debug HTML saved: ${htmlPath} (${html.length} chars)`);
    } catch (e) { console.log(`HTML dump failed: ${e.message}`); }
    // ──────────────────────────────────────────────────────────────────

    const fromNetwork = await networkPromise;
    if (fromNetwork?.type === "members" && fromNetwork.payload?.length) {
      console.log(`Using network JSON data for ${club.id}`);
      return fromNetwork.payload;
    }
    if (fromNetwork?.type === "csv" && fromNetwork.payload) {
      console.log(`Using network CSV data for ${club.id}`);
      return parseChronogenesisCsv(fromNetwork.payload, club.id);
    }

    const fromPageState = await tryExtractFromPageState(page, club.id);
    if (fromPageState?.type === "members" && fromPageState.payload?.length) {
      console.log(`Using page-state data for ${club.id}`);
      return fromPageState.payload;
    }

    console.log(`Falling back to export-click CSV for ${club.id}`);
    const csvText = await downloadChronogenesisCsv(page, club.id);
    return parseChronogenesisCsv(csvText, club.id);
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
  }
}

async function processClub(browser, club) {
  if (!club?.id || !club?.pageUrl) {
    throw new Error(`Missing id or pageUrl for club config entry: ${JSON.stringify(club)}`);
  }

  const sourceMembers = await getChronogenesisMembers(browser, club);
  console.log(`Prepared ${sourceMembers.length} Chronogenesis rows for ${club.id}`);
  const referenceJson = await loadUmaReference(club.id);
  const output = buildChronogenesisJson(club, sourceMembers, referenceJson);
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
  const browser = await chromium.launch({
    headless: false,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-infobars",
      "--window-size=1440,900",
    ],
  });

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
