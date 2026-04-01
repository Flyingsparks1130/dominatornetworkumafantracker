import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

chromium.use(StealthPlugin());

const CONFIG_PATH = path.join(process.cwd(), "scripts", "chronogenesis.clubs.config.json");
const CHRONO_DATA_DIR = path.join(process.cwd(), "data", "chronogenesis");
const SITE_ORIGIN = "https://chronogenesis.net";

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

  if (cookies.length) {
    await context.addCookies(cookies);
    console.log(`Injected ${cookies.length} cookie(s) for chronogenesis.net`);
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

function normalizeViewerId(value) {
  return String(value ?? "").replace(/\D+/g, "").trim();
}

function buildCirclePayload(club, apiPayload) {
  const clubInfo = Array.isArray(apiPayload.club) && apiPayload.club.length
    ? apiPayload.club[0]
    : {};

  return {
    circle_id: Number(club.id),
    leader_viewer_id: clubInfo.leader_viewer_id ?? null,
    name: clubInfo.name ?? club.name ?? null,
    comment: clubInfo.comment ?? null,
    member_num: clubInfo.member_num ?? null,
    join_style: clubInfo.join_style ?? null,
    policy: clubInfo.policy ?? null,
    make_time: clubInfo.make_time ?? null,
    circle_user_array: Array.isArray(clubInfo.circle_user_array) ? clubInfo.circle_user_array : [],
    daily_average: clubInfo.daily_average ?? null,
    monthly_average: clubInfo.monthly_average ?? null,
    fan_count: clubInfo.fan_count ?? null,
    rank: clubInfo.rank ?? null,
    updated_at: clubInfo.updated_at ?? null,
    is_active: clubInfo.is_active ?? null,
    rank_diff: clubInfo.rank_diff ?? null,
    names: Array.isArray(clubInfo.names) ? clubInfo.names : clubInfo.name ? [clubInfo.name] : [],
  };
}

function buildMembers(apiPayload) {
  const friendProfiles = Array.isArray(apiPayload.club_friend_profile)
    ? apiPayload.club_friend_profile
    : [];

  return friendProfiles.map((member) => ({
    viewer_id: normalizeViewerId(member.friend_viewer_id)
      ? Number(normalizeViewerId(member.friend_viewer_id))
      : null,
    trainer_name: member.name ?? null,
    friend_viewer_id: member.friend_viewer_id ?? null,
    name: member.name ?? null,
    leader_chara_id: member.leader_chara_id ?? null,
    membership: member.membership ?? null,
    daily_average: member.daily_average ?? null,
    monthly_average: member.monthly_average ?? null,
    join_time: member.join_time ?? null,
    fan_count: member.fan_count ?? null,
    honor_id: member.honor_id ?? null,
    last_login_time: member.last_login_time ?? null,
    leader_chara_dress_id: member.leader_chara_dress_id ?? null,
    support_card_id: member.support_card_id ?? null,
    team_evaluation_point: member.team_evaluation_point ?? null,
    updated_at: member.updated_at ?? null,
    names: Array.isArray(member.names) ? member.names : member.name ? [member.name] : [],
  }));
}

function buildChronogenesisJson(club, apiPayload) {
  const members = buildMembers(apiPayload);

  return {
    source: "chronogenesis_api",
    endpoint: "club_profile",
    refreshed_at: new Date().toISOString(),
    circle: buildCirclePayload(club, apiPayload),
    club_daily_history: Array.isArray(apiPayload.club_daily_history)
      ? apiPayload.club_daily_history
      : [],
    club_monthly_history: Array.isArray(apiPayload.club_monthly_history)
      ? apiPayload.club_monthly_history
      : [],
    members,
    meta: {
      total_members: members.length,
      note: "Captured from ChronoGenesis page network response. No UMA merge.",
    },
  };
}

async function captureClubProfileFromPage(page, club) {
  const apiResponsePromise = page.waitForResponse(
    async (response) => {
      const url = response.url();
      return (
        url.includes("api.chronogenesis.net/club_profile") &&
        url.includes(`circle_id=${club.id}`) &&
        response.status() === 200
      );
    },
    { timeout: 30000 }
  );

  await page.goto(club.pageUrl, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(4000);
  await dismissBlockingUi(page);

  const response = await apiResponsePromise;
  const text = await response.text();

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`club_profile ${club.id} returned invalid JSON: ${error.message}`);
  }

  if (!Array.isArray(parsed.club)) {
    throw new Error(`club_profile ${club.id} did not include a club array`);
  }

  return parsed;
}

async function saveChronogenesisJson(club, payload) {
  const outPath = path.join(CHRONO_DATA_DIR, `${club.id}.json`);
  await fs.writeFile(outPath, JSON.stringify(payload, null, 2), "utf8");
  console.log(`✅ CHRONO SAVED: ${club.id} members ${payload.meta?.total_members ?? 0}`);
}

async function main() {
  const raw = await fs.readFile(CONFIG_PATH, "utf8");
  const clubs = JSON.parse(raw);

  if (!Array.isArray(clubs) || !clubs.length) {
    throw new Error("chronogenesis.clubs.config.json must contain a non-empty array");
  }

  await fs.mkdir(CHRONO_DATA_DIR, { recursive: true });

  const browser = await chromium.launch({
    headless: process.env.HEADFUL === "1" ? false : true,
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
    Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });

    window.chrome = {
      runtime: {},
      loadTimes: function () {},
      csi: function () {},
      app: { isInstalled: false },
    };
  });

  const page = await context.newPage();
  let successCount = 0;

  try {
    await addCookiesIfPresent(context);

    for (const club of clubs) {
      console.log(`\n=== Chronogenesis API ${club.name || "Unknown"} (${club.id}) ===`);

      try {
        const apiPayload = await captureClubProfileFromPage(page, club);
        const output = buildChronogenesisJson(club, apiPayload);
        await saveChronogenesisJson(club, output);
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
    throw new Error("Chronogenesis refresh finished with 0 successful clubs");
  }
}

main().catch((error) => {
  console.error("FATAL ERROR:", error);
  process.exit(1);
});
