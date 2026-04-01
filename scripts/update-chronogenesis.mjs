import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

chromium.use(StealthPlugin());

const CONFIG_PATH = path.join(process.cwd(), "scripts", "chronogenesis.clubs.config.json");
const UMA_REFERENCE_DIR = path.join(process.cwd(), "data");
const CHRONO_DATA_DIR = path.join(process.cwd(), "data", "chronogenesis");

const SITE_ORIGIN = "https://chronogenesis.net";
const API_ORIGIN = "https://api.chronogenesis.net";
const DEFAULT_TIMEOUT_MS = 60_000;

function normalizeViewerId(value) {
  return String(value ?? "").replace(/\D+/g, "").trim();
}

function decodeBase64Url(value) {
  const normalized = String(value || "")
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(String(value || "").length / 4) * 4, "=");

  return Buffer.from(normalized, "base64").toString("utf8");
}

function decodeJwtPayload(token) {
  const parts = String(token || "").split(".");
  if (parts.length < 2) return null;

  try {
    return JSON.parse(decodeBase64Url(parts[1]));
  } catch {
    return null;
  }
}

function deriveCgCarrotFromKurono(token) {
  const payload = decodeJwtPayload(token);
  return payload?.js_fp || null;
}

async function addCookiesIfPresent(context) {
  const raw = String(process.env.DOWNLOAD_COOKIE || "").trim();
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
        url: SITE_ORIGIN,
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

async function waitForKuronoCookie(context, timeoutMs = 30_000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const cookies = await context.cookies(SITE_ORIGIN, API_ORIGIN);
      const cookie = cookies.find((entry) => entry.name === "kurono" && entry.value);
      if (cookie) return cookie;
    } catch {}

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  return null;
}

async function bootstrapSession(page, context, bootstrapUrl) {
  await page.goto(bootstrapUrl, {
    waitUntil: "domcontentloaded",
    timeout: DEFAULT_TIMEOUT_MS,
  });

  await page.waitForTimeout(4000);
  await dismissBlockingUi(page);

  const kuronoCookie = await waitForKuronoCookie(context, 30_000);
  if (!kuronoCookie?.value) {
    throw new Error("Could not find a valid kurono cookie after loading ChronoGenesis");
  }

  const cgCarrot = deriveCgCarrotFromKurono(kuronoCookie.value);
  if (!cgCarrot) {
    throw new Error("Could not derive cg-carrot from the kurono cookie payload");
  }

  console.log(`Bootstrapped ChronoGenesis session via ${bootstrapUrl}`);
  return { cgCarrot, kurono: kuronoCookie.value };
}

async function fetchClubProfile(page, circleId, cgCarrot) {
  const result = await page.evaluate(
    async ({ circleId, cgCarrot }) => {
      try {
        const response = await fetch(
          `https://api.chronogenesis.net/club_profile?circle_id=${encodeURIComponent(circleId)}`,
          {
            method: "GET",
            credentials: "include",
            headers: {
              accept: "*/*",
              "cg-carrot": cgCarrot,
            },
          }
        );

        const text = await response.text();
        return {
          ok: response.ok,
          status: response.status,
          text,
        };
      } catch (error) {
        return {
          ok: false,
          status: 0,
          text: String(error?.message || error),
        };
      }
    },
    { circleId: String(circleId), cgCarrot }
  );

  if (!result.ok) {
    throw new Error(`club_profile ${circleId} failed (${result.status}): ${result.text.slice(0, 250)}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(result.text);
  } catch (error) {
    throw new Error(`club_profile ${circleId} returned invalid JSON: ${error.message}`);
  }

  if (!Array.isArray(parsed.club)) {
    throw new Error(`club_profile ${circleId} did not include a club array`);
  }

  return parsed;
}

async function fetchClubProfileWithRefresh(client, club) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await fetchClubProfile(client.page, club.id, client.cgCarrot);
    } catch (error) {
      if (attempt === 2) throw error;

      console.warn(`Retrying ${club.id} after refreshing session: ${error.message}`);
      const refreshed = await bootstrapSession(client.page, client.context, club.pageUrl);
      client.cgCarrot = refreshed.cgCarrot;
    }
  }

  throw new Error(`Unreachable fetch retry state for ${club.id}`);
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

function inferCircleMeta(apiPayload, referenceJson, club, memberCount) {
  const clubInfo = Array.isArray(apiPayload.club) && apiPayload.club.length ? apiPayload.club[0] : {};
  const refCircle = referenceJson?.circle || {};

  return {
    circle_id: Number(club.id),
    name: clubInfo.name ?? refCircle.name ?? club.name ?? null,
    comment: clubInfo.comment ?? refCircle.comment ?? null,
    leader_viewer_id: clubInfo.leader_viewer_id ?? refCircle.leader_viewer_id ?? null,
    leader_name: refCircle.leader_name ?? null,
    member_count: clubInfo.member_num ?? refCircle.member_count ?? memberCount,
    join_style: clubInfo.join_style ?? refCircle.join_style ?? null,
    policy: clubInfo.policy ?? refCircle.policy ?? null,
    created_at: clubInfo.make_time ?? refCircle.created_at ?? null,
    updated_at: clubInfo.updated_at ?? refCircle.last_updated ?? null,
    fan_count: clubInfo.fan_count ?? null,
    daily_average: clubInfo.daily_average ?? null,
    monthly_average: clubInfo.monthly_average ?? null,
    rank: clubInfo.rank ?? null,
    rank_diff: clubInfo.rank_diff ?? null,
    is_active: clubInfo.is_active ?? null,
    names: Array.isArray(clubInfo.names) ? clubInfo.names : clubInfo.name ? [clubInfo.name] : [],
    archived: refCircle.archived ?? false,
    yesterday_updated: refCircle.yesterday_updated ?? null,
    yesterday_points: refCircle.yesterday_points ?? null,
    yesterday_rank: refCircle.yesterday_rank ?? null,
    live_points: refCircle.live_points ?? null,
    live_rank: refCircle.live_rank ?? null,
  };
}

function buildChronogenesisJson(club, apiPayload, referenceJson) {
  const refLookup = buildReferenceLookup(referenceJson);
  const now = new Date();

  let matched = 0;
  const friendProfiles = Array.isArray(apiPayload.club_friend_profile) ? apiPayload.club_friend_profile : [];

  const members = friendProfiles.map((member) => {
    const viewerId = normalizeViewerId(member.friend_viewer_id);
    const ref = refLookup.get(viewerId);

    if (ref) matched += 1;

    return {
      id: ref?.id ?? null,
      circle_id: Number(club.id),
      viewer_id: viewerId ? Number(viewerId) : null,
      trainer_name: ref?.trainer_name ?? member.name ?? null,
      year: ref?.year ?? now.getUTCFullYear(),
      month: ref?.month ?? now.getUTCMonth() + 1,
      daily_fans: [],
      fan_count: member.fan_count ?? null,
      daily_average: member.daily_average ?? null,
      monthly_average: member.monthly_average ?? null,
      membership: member.membership ?? null,
      join_time: member.join_time ?? null,
      last_login_time: member.last_login_time ?? null,
      updated_at: member.updated_at ?? null,
      leader_chara_id: member.leader_chara_id ?? null,
      leader_chara_dress_id: member.leader_chara_dress_id ?? null,
      support_card_id: member.support_card_id ?? null,
      team_evaluation_point: member.team_evaluation_point ?? null,
      honor_id: member.honor_id ?? null,
      names: Array.isArray(member.names) ? member.names : member.name ? [member.name] : [],
      isActive: ref?.isActive ?? true,
    };
  });

  return {
    source: "chronogenesis_api",
    endpoint: "club_profile",
    refreshed_at: now.toISOString(),
    circle: inferCircleMeta(apiPayload, referenceJson, club, members.length),
    club_daily_history: Array.isArray(apiPayload.club_daily_history) ? apiPayload.club_daily_history : [],
    club_monthly_history: Array.isArray(apiPayload.club_monthly_history) ? apiPayload.club_monthly_history : [],
    members,
    meta: {
      matched_members: matched,
      total_members: members.length,
      member_history_available: false,
      note: "club_profile provides club and friend profile snapshots, not per-member daily_fans arrays",
    },
  };
}

async function saveChronogenesisJson(club, payload) {
  const outPath = path.join(CHRONO_DATA_DIR, `${club.id}.json`);
  await fs.writeFile(outPath, JSON.stringify(payload, null, 2), "utf8");
  console.log(
    `✅ CHRONO SAVED: ${club.id} matched ${payload.meta?.matched_members ?? 0}/${payload.meta?.total_members ?? 0}`
  );
}

async function processClub(client, club) {
  if (!club?.id || !club?.pageUrl) {
    throw new Error(`Missing id or pageUrl for club config entry: ${JSON.stringify(club)}`);
  }

  const apiPayload = await fetchClubProfileWithRefresh(client, club);
  const referenceJson = await loadUmaReference(club.id);
  const output = buildChronogenesisJson(club, apiPayload, referenceJson);
  await saveChronogenesisJson(club, output);
}

async function main() {
  const raw = await fs.readFile(CONFIG_PATH, "utf8");
  const clubs = JSON.parse(raw);

  if (!Array.isArray(clubs) || !clubs.length) {
    throw new Error("chronogenesis.clubs.config.json must contain a non-empty array");
  }

  await fs.mkdir(CHRONO_DATA_DIR, { recursive: true });

  const headless = process.env.HEADFUL === "1" ? false : true;

  const browser = await chromium.launch({
    headless,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-infobars",
      "--window-size=1440,900",
    ],
  });

  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
    locale: "en-US",
    timezoneId: "America/New_York",
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
    Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
    Object.defineProperty(navigator, "plugins", {
      get: () => [1, 2, 3, 4, 5],
    });

    window.chrome = {
      runtime: {},
      loadTimes: function () {},
      csi: function () {},
      app: { isInstalled: false },
    };

    const originalQuery = window.navigator.permissions?.query;
    if (originalQuery) {
      window.navigator.permissions.query = (parameters) =>
        parameters.name === "notifications"
          ? Promise.resolve({ state: Notification.permission })
          : originalQuery(parameters);
    }
  });

  let successCount = 0;
  const page = await context.newPage();

  try {
    await addCookiesIfPresent(context);

    const bootstrapClub = clubs.find((club) => club?.pageUrl) || { pageUrl: SITE_ORIGIN };
    const session = await bootstrapSession(page, context, bootstrapClub.pageUrl);
    const client = { browser, context, page, cgCarrot: session.cgCarrot };

    for (const club of clubs) {
      console.log(`\n=== Chronogenesis API ${club.name || "Unknown"} (${club.id}) ===`);

      try {
        await processClub(client, club);
        successCount += 1;
      } catch (error) {
        console.error(`❌ CHRONO FAILED: ${club.id}`);
        console.error(error.message);
      }
    }
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }

  if (successCount === 0) {
    throw new Error("Chronogenesis API refresh finished with 0 successful clubs");
  }
}

main().catch((error) => {
  console.error("FATAL ERROR:", error);
  process.exit(1);
});
