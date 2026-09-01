const { useState, useEffect, useRef } = React;

    const DATA_SOURCE = "chronogenesis";
    const FRONTEND_CONFIG_PATHS = ["./config/frontend.json", "/config/frontend.json"];
    const PAGE_MODE = document.body?.dataset?.page || "home";
    const RANKINGS_MEMBER_DEFAULT_COUNT = 25;
    const RANKINGS_MEMBER_PAGE_SIZE = 10;
    let CURRENT_CLUBS = [];

    function applyTierTargets(config) {
      const tierTargets = config?.tierTargets || {};
      const clubs = Array.isArray(config?.clubs) ? config.clubs : [];
      return clubs.map((club) => {
        const configuredTarget = club.targetOverride ?? tierTargets[club.tier];
        const target = Number(configuredTarget);
        if (!Number.isFinite(target) || target <= 0) {
          throw new Error(`Missing a valid target for ${club.name || club.id || "unknown club"} (${club.tier || "no tier"}).`);
        }
        return { ...club, id: String(club.id || ""), target };
      });
    }

    async function loadFrontendConfig() {
      const errors = [];
      for (const url of FRONTEND_CONFIG_PATHS) {
        try {
          const response = await fetch(url, { headers: { Accept: "application/json" }, cache: "no-store" });
          if (!response.ok) {
            errors.push(`${url}: HTTP ${response.status}`);
            continue;
          }
          const config = await response.json();
          const clubs = applyTierTargets(config);
          if (!clubs.length) throw new Error("No clubs were defined.");
          return { config, clubs };
        } catch (error) {
          errors.push(`${url}: ${error.message}`);
        }
      }

      const fallback = window.__SNAPSHOT_COMPAT__?.clubs;
      if (Array.isArray(fallback) && fallback.length) {
        console.warn("Frontend config could not be loaded; using the protected snapshot compatibility fallback.", errors);
        return { config: window.__SNAPSHOT_COMPAT__, clubs: fallback.map((club) => ({ ...club, id: String(club.id || "") })) };
      }

      throw new Error(`Unable to load config/frontend.json. ${errors.join(" | ")}`);
    }

    function getDataCandidates(targetId, archiveMonth = "") {
      if (archiveMonth) {
        const archiveName = `${targetId}_${archiveMonth}.json`;
        return [`./data/chronogenesis/archive/${archiveName}`, `/data/chronogenesis/archive/${archiveName}`];
      }
      return [`./data/chronogenesis/${targetId}.json`, `/data/chronogenesis/${targetId}.json`];
    }

    function safeIso(value) {
      if (!value) return null;
      const parsed = new Date(value);
      return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
    }

    function getChronogenesisDatasetMonthInfo(json, now = new Date()) {
      const firstMonth = Array.isArray(json?.month_filter) ? json.month_filter[0]?.sdate : null;
      if (firstMonth) {
        const match = String(firstMonth).match(/^(\d{4})-(\d{2})-\d{2}/);
        if (match) {
          const year = Number(match[1]);
          const month = Number(match[2]);
          if (Number.isFinite(year) && Number.isFinite(month) && month >= 1 && month <= 12) {
            return { year, month, monthIndex: month - 1, key: formatDateKey(year, month, 1).slice(0, 7) };
          }
        }
      }

      const latestYearMonth = Array.isArray(json?.club_monthly_history)
        ? json.club_monthly_history.map((row) => Number(row?.year_month)).filter((value) => Number.isFinite(value) && value > 190001).sort((a, b) => b - a)[0]
        : null;
      if (latestYearMonth) {
        const year = Math.floor(latestYearMonth / 100);
        const month = latestYearMonth % 100;
        if (Number.isFinite(year) && Number.isFinite(month) && month >= 1 && month <= 12) {
          return { year, month, monthIndex: month - 1, key: formatDateKey(year, month, 1).slice(0, 7) };
        }
      }

      return { year: now.getFullYear(), month: now.getMonth() + 1, monthIndex: now.getMonth(), key: formatDateKey(now.getFullYear(), now.getMonth() + 1, 1).slice(0, 7) };
    }

    function getMonthKeyLabel(monthKey) {
      if (!/^\d{4}-\d{2}$/.test(String(monthKey || ""))) return "Unknown month";
      const [year, month] = monthKey.split("-").map(Number);
      return new Date(year, month - 1, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" });
    }

    function getTierForRank(monthlyRank, rankingConfig = RANKING_CONFIG) {
      if (monthlyRank == null) return null;
      const config = Array.isArray(rankingConfig) && rankingConfig.length ? rankingConfig : RANKING_CONFIG;
      const entry = config.find((r) => monthlyRank >= r.min && (r.max === null || monthlyRank <= r.max));
      return entry ? entry.tier : null;
    }

    function getRankIconUrl(tierName, rankingConfig = RANKING_CONFIG, rankIconPath = RANK_ICON_PATH) {
      const config = Array.isArray(rankingConfig) && rankingConfig.length ? rankingConfig : RANKING_CONFIG;
      const entry = config.find((r) => r.tier === tierName);
      const basePath = typeof rankIconPath === "string" && rankIconPath ? rankIconPath : RANK_ICON_PATH;
      return entry ? basePath + entry.icon + ".png" : null;
    }

    function TierIcon({ tier, size = 20, title = null, showFallbackText = true, style = {}, rankingConfig = RANKING_CONFIG, rankIconPath = RANK_ICON_PATH }) {
      const iconUrl = getRankIconUrl(tier, rankingConfig, rankIconPath);
      const [failed, setFailed] = React.useState(false);

      if (!iconUrl || failed) {
        return showFallbackText ? (
          <span
            title={title || tier}
            style={{
              fontSize: Math.max(10, Math.round(size * 0.6)),
              fontWeight: 800,
              color: "#e2e0f0",
              lineHeight: 1,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              ...style,
            }}
          >
            {tier}
          </span>
        ) : null;
      }

      return (
        <img
          src={iconUrl}
          alt={title || `${tier} badge`}
          title={title || tier}
          style={{
            width: size,
            height: size,
            objectFit: "contain",
            display: "block",
            flex: "0 0 auto",
            ...style,
          }}
          onError={() => setFailed(true)}
        />
      );
    }

    const TIER_RANK = { "S": 0, "A+": 1, "A": 2, "B+": 3 };
    const CLUB_TIER_ORDER = ["S", "A+", "A", "B+"];

    function normalizeArchiveFrontendConfig(config) {
      if (!config || typeof config !== "object") return null;
      const clubs = Array.isArray(config.clubs) ? config.clubs.filter((club) => club && club.id) : [];
      const rankingConfig = Array.isArray(config.rankingConfig) ? config.rankingConfig : (Array.isArray(config.ranking_config) ? config.ranking_config : []);
      const clubTierOrder = Array.isArray(config.clubTierOrder) ? config.clubTierOrder : (Array.isArray(config.club_tier_order) ? config.club_tier_order : []);
      return {
        schema: Number(config.schema || 1),
        capturedAt: config.capturedAt || config.captured_at || config.createdAt || config.created_at || null,
        sourceFile: config.sourceFile || config.source_file || null,
        clubs,
        clubConfig: config.clubConfig || config.club_config || null,
        rankingConfig,
        clubTierOrder,
        maxMembers: Number(config.maxMembers ?? config.max_members ?? MAX_MEMBERS),
        rankIconPath: typeof (config.rankIconPath ?? config.rank_icon_path) === "string" && (config.rankIconPath ?? config.rank_icon_path) ? (config.rankIconPath ?? config.rank_icon_path) : RANK_ICON_PATH,
        tierColors: (config.tierColors || config.tier_colors) && typeof (config.tierColors || config.tier_colors) === "object" ? (config.tierColors || config.tier_colors) : TIER_COLORS,
        clubConfigById: (config.clubConfigById || config.club_config_by_id) && typeof (config.clubConfigById || config.club_config_by_id) === "object" ? (config.clubConfigById || config.club_config_by_id) : {},
      };
    }

    function getArchiveFrontendConfig(json) {
      const archive = json?._archive || {};
      return normalizeArchiveFrontendConfig(
        archive.frontendConfig ||
        archive.frontEndConfig ||
        archive.configSnapshot ||
        archive.config ||
        null
      );
    }

    function getViewClubs(archiveConfig) {
      return archiveConfig?.clubs?.length ? archiveConfig.clubs : CURRENT_CLUBS;
    }

    function getViewRankingConfig(archiveConfig) {
      return archiveConfig?.rankingConfig?.length ? archiveConfig.rankingConfig : RANKING_CONFIG;
    }

    function getViewClubTierOrder(archiveConfig) {
      return archiveConfig?.clubTierOrder?.length ? archiveConfig.clubTierOrder : CLUB_TIER_ORDER;
    }

    function getViewRankIconPath(archiveConfig) {
      return typeof archiveConfig?.rankIconPath === "string" && archiveConfig.rankIconPath ? archiveConfig.rankIconPath : RANK_ICON_PATH;
    }

    function getViewTierColors(archiveConfig) {
      return archiveConfig?.tierColors && typeof archiveConfig.tierColors === "object" ? archiveConfig.tierColors : TIER_COLORS;
    }

    const HEALTH_GRADES = [
      { min: 0.95, grade: "A+", color: "#34d399", bg: "#34d39922" },
      { min: 0.90, grade: "A",  color: "#34d399", bg: "#34d39922" },
      { min: 0.85, grade: "B+", color: "#60a5fa", bg: "#60a5fa22" },
      { min: 0.80, grade: "B",  color: "#60a5fa", bg: "#60a5fa22" },
      { min: 0.75, grade: "C+", color: "#fbbf24", bg: "#fbbf2422" },
      { min: 0.70, grade: "C",  color: "#fbbf24", bg: "#fbbf2422" },
      { min: 0.60, grade: "D",  color: "#f97316", bg: "#f9731622" },
      { min: 0,    grade: "F",  color: "#f87171", bg: "#f8717122" },
    ];

    const DAY1_STATUS_KEY = "na-day1";
    const STATUS_META = {
      "on-track": { label: "On Track", icon: "✅", color: "#34d399", bg: "#34d39922", border: "#34d39966" },
      "behind":   { label: "Behind", icon: "⚠️", color: "#fbbf24", bg: "#fbbf2422", border: "#fbbf2466" },
      "critical": { label: "Critical", icon: "❗", color: "#f87171", bg: "#f8717122", border: "#f8717166" },
      "na-day1":  { label: "N/A - Day 1", icon: "⚪", color: "#9ca3af", bg: "#9ca3af22", border: "#9ca3af66" },
    };

    const fmt = (n) => {
      if (n == null) return "—";
      const abs = Math.abs(n);
      const sign = n < 0 ? "-" : "";
      if (abs >= 1_000_000_000) return sign + (abs / 1_000_000_000).toFixed(2) + "B";
      if (abs >= 1_000_000) return sign + (abs / 1_000_000).toFixed(2) + "M";
      if (abs >= 1_000) return sign + (abs / 1_000).toFixed(1) + "K";
      return sign + Number(abs).toLocaleString();
    };

    const fmtFull = (n) => (n == null ? "—" : Number(n).toLocaleString());
    const fmtSigned = (n) => {
      if (n == null) return "—";
      return `${n >= 0 ? "+" : ""}${fmt(n)}`;
    };
    const daysInMonth = (y, m) => new Date(y, m, 0).getDate();
    const gainColor = (n) => n == null ? "#6b7280" : n > 0 ? "#34d399" : n < 0 ? "#f87171" : "#9ca3af";

    function getClubColor(i) { return `hsl(${(i * 67 + 20) % 360}, 70%, 58%)`; }


    function getSuggestedTierForProjectedMonthly(projectedMonthly = 0, clubs = CURRENT_CLUBS) {
      const value = Math.max(0, Number(projectedMonthly) || 0);
      const sourceClubs = Array.isArray(clubs) && clubs.length ? clubs : CURRENT_CLUBS;
      const ordered = [...sourceClubs].sort((a, b) => b.target - a.target);
      const match = ordered.find((club) => value >= club.target);
      return match ? match.tier : "B+";
    }

    function getExpectedClubTier(currentTier, projectedMonthly = 0, direction = "promotion", clubs = CURRENT_CLUBS, clubTierOrder = CLUB_TIER_ORDER) {
      const value = Math.max(0, Number(projectedMonthly) || 0);
      const sourceClubs = Array.isArray(clubs) && clubs.length ? clubs : CURRENT_CLUBS;
      const tierOrder = Array.isArray(clubTierOrder) && clubTierOrder.length ? clubTierOrder : CLUB_TIER_ORDER;
      const minClubTarget = Math.min(...sourceClubs.map((club) => club.target));
      if (direction === "demotion" && value < minClubTarget) return "Remove";
      const suggestedTier = getSuggestedTierForProjectedMonthly(value, sourceClubs);
      const currentIdx = tierOrder.indexOf(currentTier);
      const suggestedIdx = tierOrder.indexOf(suggestedTier);
      if (currentIdx < 0 || suggestedIdx < 0) return suggestedTier;
      if (direction === "promotion") return suggestedIdx < currentIdx ? suggestedTier : currentTier;
      if (direction === "demotion") return suggestedIdx > currentIdx ? suggestedTier : currentTier;
      return suggestedTier;
    }

    function clamp01(value) {
      if (!Number.isFinite(Number(value))) return 0;
      return Math.min(1, Math.max(0, Number(value)));
    }

    function computeHealthGrade(pctOnTrack, projectedRatio, nonStagnantRatio) {
      const normalizedOnTrack = clamp01(pctOnTrack);
      const normalizedProjectedRatio = clamp01(projectedRatio);
      const normalizedNonStagnantRatio = clamp01(nonStagnantRatio);
      const components = {
        onTrack: {
          label: "On-track members",
          weight: 0.40,
          ratio: normalizedOnTrack,
          weightedScore: normalizedOnTrack * 0.40,
          accent: "#34d399",
        },
        projected: {
          label: "Projected vs target",
          weight: 0.35,
          ratio: normalizedProjectedRatio,
          weightedScore: normalizedProjectedRatio * 0.35,
          accent: "#c4b5fd",
        },
        activity: {
          label: "Active members",
          weight: 0.25,
          ratio: normalizedNonStagnantRatio,
          weightedScore: normalizedNonStagnantRatio * 0.25,
          accent: "#60a5fa",
        },
      };
      const rawScore = components.onTrack.weightedScore + components.projected.weightedScore + components.activity.weightedScore;
      const g = HEALTH_GRADES.find((h) => rawScore >= h.min) || HEALTH_GRADES[HEALTH_GRADES.length - 1];
      return { ...g, rawScore, score: Math.round(rawScore * 100), components };
    }

    function getStagnantDays(dailyGainSeries, todayIdx) {
      let count = 0;
      for (let i = todayIdx; i >= 0; i--) {
        if ((dailyGainSeries[i] ?? 0) <= 0) count++;
        else break;
      }
      return count;
    }

    function isSameCalendarDay(a, b) {
      return (a && b && a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate());
    }

    const REFRESH_SCHEDULE = {
      timeZone: "Asia/Bangkok",
      label: "UTC+7",
      slots: [
        { hour: 17, minute: 15, label: "5:15 PM" },
      ],
    };
    const SCHEDULE_AUTO_REFRESH_WINDOW_MS = 8 * 60 * 1000;
    const SCHEDULE_AUTO_REFRESH_RETRY_DELAYS_MS = [5_000, 20_000, 45_000, 90_000, 150_000];
    const EFFECTIVE_DAY_STORAGE_KEY = "dominatorTrackerEffectiveGameDay";

    function pad2(n) { return String(n).padStart(2, "0"); }
    function formatDateKey(year, month, day) { return `${year}-${pad2(month)}-${pad2(day)}`; }
    function formatLocalDateKey(date) { return formatDateKey(date.getFullYear(), date.getMonth() + 1, date.getDate()); }
    function isDateKey(value) { return /^\d{4}-\d{2}-\d{2}$/.test(String(value || "")); }

    function getPreviousDisplayKeyFromKey(key) {
      if (!isDateKey(key)) return key;
      const [year, month, day] = String(key).split("-").map(Number);
      const previous = new Date(Date.UTC(year, month - 1, day));
      previous.setUTCDate(previous.getUTCDate() - 1);
      const shifted = formatDateKey(previous.getUTCFullYear(), previous.getUTCMonth() + 1, previous.getUTCDate());
      return shifted.slice(0, 7) === key.slice(0, 7) ? shifted : key;
    }

    function getTimeZoneParts(date, timeZone = REFRESH_SCHEDULE.timeZone) {
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      }).formatToParts(date).reduce((acc, part) => {
        if (part.type !== "literal") acc[part.type] = part.value;
        return acc;
      }, {});
      return {
        year: Number(parts.year),
        month: Number(parts.month),
        day: Number(parts.day),
        hour: Number(parts.hour),
        minute: Number(parts.minute),
        second: Number(parts.second),
      };
    }

    function parseShortOffsetToMinutes(offsetLabel) {
      const normalized = String(offsetLabel || "GMT").replace("UTC", "GMT");
      if (normalized === "GMT") return 0;
      const match = normalized.match(/^GMT([+-])(\d{1,2})(?::?(\d{2}))?$/);
      if (!match) return 0;
      const sign = match[1] === "-" ? -1 : 1;
      const hours = Number(match[2] || 0);
      const minutes = Number(match[3] || 0);
      return sign * ((hours * 60) + minutes);
    }

    function getTimeZoneOffsetMinutes(date, timeZone = REFRESH_SCHEDULE.timeZone) {
      const tzNamePart = new Intl.DateTimeFormat("en-US", {
        timeZone,
        timeZoneName: "shortOffset",
        hour: "2-digit",
      }).formatToParts(date).find((part) => part.type === "timeZoneName");
      return parseShortOffsetToMinutes(tzNamePart?.value || "GMT");
    }

    function zonedTimeToUtc(parts, timeZone = REFRESH_SCHEDULE.timeZone) {
      const utcGuessMs = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour || 0, parts.minute || 0, parts.second || 0, 0);
      const initialOffset = getTimeZoneOffsetMinutes(new Date(utcGuessMs), timeZone);
      let resolved = new Date(utcGuessMs - initialOffset * 60 * 1000);
      const resolvedOffset = getTimeZoneOffsetMinutes(resolved, timeZone);
      if (resolvedOffset !== initialOffset) resolved = new Date(utcGuessMs - resolvedOffset * 60 * 1000);
      return resolved;
    }

    function addDaysToParts(parts, deltaDays) {
      const utc = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
      utc.setUTCDate(utc.getUTCDate() + deltaDays);
      return { year: utc.getUTCFullYear(), month: utc.getUTCMonth() + 1, day: utc.getUTCDate() };
    }

    function formatRefreshDateLabel(date) {
      return new Intl.DateTimeFormat("en-US", {
        timeZone: REFRESH_SCHEDULE.timeZone,
        weekday: "short",
        hour: "numeric",
        minute: "2-digit",
        timeZoneName: "short",
      }).format(date);
    }

    function formatCountdown(ms) {
      const totalSeconds = Math.max(0, Math.floor(ms / 1000));
      const hours = Math.floor(totalSeconds / 3600);
      const minutes = Math.floor((totalSeconds % 3600) / 60);
      const seconds = totalSeconds % 60;
      if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m ${String(seconds).padStart(2, "0")}s`;
      if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
      return `${seconds}s`;
    }

    function buildRefreshScheduleEntries(now = new Date(), dayOffsets = [-1, 0, 1, 2]) {
      const zonedNowParts = getTimeZoneParts(now, REFRESH_SCHEDULE.timeZone);
      const dayPartsList = dayOffsets.map((delta) => addDaysToParts(zonedNowParts, delta));
      const candidates = [];
      dayPartsList.forEach((dayParts) => {
        REFRESH_SCHEDULE.slots.forEach((slot) => {
          const date = zonedTimeToUtc({ ...dayParts, hour: slot.hour, minute: slot.minute, second: 0 }, REFRESH_SCHEDULE.timeZone);
          candidates.push({
            key: `${DATA_SOURCE}-${formatDateKey(dayParts.year, dayParts.month, dayParts.day)}-${pad2(slot.hour)}:${pad2(slot.minute)}`,
            date,
            slot,
            label: slot.label,
          });
        });
      });
      return candidates.sort((a, b) => a.date - b.date);
    }

    function getUpcomingRefreshSchedule(now = new Date(), count = 1) {
      return buildRefreshScheduleEntries(now).filter((entry) => entry.date.getTime() > now.getTime() + 999).slice(0, count);
    }

    function getLatestStartedRefresh(now = new Date()) {
      const started = buildRefreshScheduleEntries(now).filter((entry) => entry.date.getTime() <= now.getTime() + 999);
      return started.length ? started[started.length - 1] : null;
    }

    function getRefreshScheduleMeta(now = new Date()) {
      const upcoming = getUpcomingRefreshSchedule(now, 1);
      const next = upcoming[0] || null;
      const latestStarted = getLatestStartedRefresh(now);
      return {
        next,
        upcoming,
        latestStarted,
        countdownMs: next ? Math.max(0, next.date.getTime() - now.getTime()) : 0,
        label: REFRESH_SCHEDULE.label,
        timeZone: REFRESH_SCHEDULE.timeZone,
      };
    }

    function dateKeyToLocalDate(key) {
      const [year, month, day] = String(key).split("-").map(Number);
      return new Date(year, month - 1, day);
    }

    function getChronogenesisSharedActualDay(result) {
      if (result?.sourceType !== DATA_SOURCE) return null;
      const explicitSharedDay = Number(result?.sharedActualDate ?? 0);
      return Number.isFinite(explicitSharedDay) && explicitSharedDay > 0 ? explicitSharedDay : null;
    }

    function getChronogenesisDisplayKey(result, now = new Date()) {
      const sharedDay = getChronogenesisSharedActualDay(result);
      if (!sharedDay) return null;
      const year = Number(result?.dataYear) || now.getFullYear();
      const month = Number(result?.dataMonth) || (now.getMonth() + 1);
      return formatDateKey(year, month, sharedDay);
    }

    function getInitialEffectiveGameDayKey(now = new Date()) {
      const storedKey = safeReadStoredGameDayKey();
      if (storedKey && storedKey.slice(0, 7) === formatDateKey(now.getFullYear(), now.getMonth() + 1, 1).slice(0, 7)) return storedKey;
      return formatDateKey(now.getFullYear(), now.getMonth() + 1, 1);
    }

    function resolveEffectiveGameDayKey(currentKey, result, now = new Date()) {
      return getChronogenesisDisplayKey(result, now) || currentKey || formatDateKey(now.getFullYear(), now.getMonth() + 1, 1);
    }

    function safeReadStoredGameDayKey() {
      try { const stored = localStorage.getItem(EFFECTIVE_DAY_STORAGE_KEY); return isDateKey(stored) ? stored : null; } catch (e) { return null; }
    }
    function safeWriteStoredGameDayKey(key) {
      try { if (isDateKey(key)) localStorage.setItem(EFFECTIVE_DAY_STORAGE_KEY, key); } catch (e) {}
    }

    function getJsonLoadMeta(entry, cdata, now) {
      if (!entry.id) return { label: "⏳ Not Configured", color: "#6b7280", sub: "Club JSON not set up yet" };
      if (!cdata) return { label: "❌ No JSON", color: "#f87171", sub: "No JSON file loaded" };
      if (cdata.archiveMonthKey && cdata.sourceType === DATA_SOURCE) return { label: "📦 Archive", color: "#c4b5fd", sub: `Snapshot month ${getMonthKeyLabel(cdata.archiveMonthKey)}` };

      const effectiveTimestamp = cdata.refreshedAt || cdata.sourceUpdatedAt || cdata.lastFetch || null;
      if (!effectiveTimestamp) return { label: "⚠️ Outdated", color: "#fbbf24", sub: "Missing refresh timestamp" };
      const parsed = new Date(effectiveTimestamp);
      if (Number.isNaN(parsed.getTime())) return { label: "⚠️ Outdated", color: "#fbbf24", sub: "Invalid refresh timestamp" };

      const scheduleMeta = getRefreshScheduleMeta(now);
      const latestStarted = scheduleMeta.latestStarted;
      const nextRefresh = scheduleMeta.next;
      const lastUpdatedLabel = parsed.toLocaleString();

      // Chronogenesis only refreshes once per day at 5:15 PM UTC+7. Yesterday's
      // file remains current until the next refresh slot has actually started.
      const graceMs = 30 * 60 * 1000;
      const latestRequiredAt = latestStarted?.date || null;
      const isFreshForLatestRefreshCycle = latestRequiredAt
        ? parsed.getTime() >= (latestRequiredAt.getTime() - graceMs)
        : true;

      if (isFreshForLatestRefreshCycle) {
        const nextText = nextRefresh ? ` · next refresh ${formatRefreshDateLabel(nextRefresh.date)}` : "";
        return { label: "✅ JSON Loaded", color: "#34d399", sub: `Last updated ${lastUpdatedLabel} · current for latest 5:15 PM UTC+7 cycle${nextText}` };
      }

      const requiredLabel = latestRequiredAt ? formatRefreshDateLabel(latestRequiredAt) : "latest scheduled refresh";
      return { label: "⚠️ Outdated", color: "#fbbf24", sub: `Last updated ${lastUpdatedLabel} · missing refresh after ${requiredLabel}` };
    }

    function getPodiumStyle(index) {
      if (index === 0) return { color: "#fbbf24", textShadow: "0 0 10px rgba(251,191,36,0.15)" };
      if (index === 1) return { color: "#d1d5db", textShadow: "0 0 10px rgba(209,213,219,0.12)" };
      if (index === 2) return { color: "#d97706", textShadow: "0 0 10px rgba(217,119,6,0.12)" };
      if (index === 3) return { color: "#9ca3af", textShadow: "none" };
      return { color: "#6b7280", textShadow: "none" };
    }

    function getLineColor(index) { return `hsl(${(index * 47) % 360}, 72%, 62%)`; }

    function parseChronogenesisJson(json, dataDateOverride = null) {
      const clubRoot = Array.isArray(json?.club) ? json.club[0] : null;
      if (!clubRoot) return { error: "No club array found. Keys in JSON: " + Object.keys(json || {}).join(", ") };

      const now = new Date();
      const datasetMonth = getChronogenesisDatasetMonthInfo(json, now);
      const actualDateMax = Array.isArray(json?.club_friend_history)
        ? json.club_friend_history.reduce((maxDay, row) => {
            const actualDate = Number(row?.actual_date);
            return Number.isFinite(actualDate) ? Math.max(maxDay, actualDate) : maxDay;
          }, 0)
        : 0;
      const fallbackDate = actualDateMax > 0
        ? new Date(datasetMonth.year, datasetMonth.monthIndex, actualDateMax)
        : new Date(datasetMonth.year, datasetMonth.monthIndex, 1);
      const effectiveDataDate = dataDateOverride instanceof Date && !Number.isNaN(dataDateOverride.getTime()) ? new Date(dataDateOverride) : fallbackDate;
      const dim = daysInMonth(effectiveDataDate.getFullYear(), effectiveDataDate.getMonth() + 1);

      const friendProfiles = Array.isArray(json?.club_friend_profile) ? json.club_friend_profile : [];
      const friendHistory = Array.isArray(json?.club_friend_history) ? json.club_friend_history : [];
      const activeRosterIds = new Set(
        Array.isArray(clubRoot?.circle_user_array)
          ? clubRoot.circle_user_array.map((id) => String(id))
          : []
      );

      const historyByViewerId = {};
      const historyDaysByViewerId = {};
      friendHistory.forEach((row) => {
        const id = row?.friend_viewer_id;
        if (id == null) return;
        if (!historyByViewerId[id]) historyByViewerId[id] = new Array(dim).fill(0);
        if (!historyDaysByViewerId[id]) historyDaysByViewerId[id] = new Set();
        const actualDate = Number(row?.actual_date);
        if (!Number.isFinite(actualDate) || actualDate < 1 || actualDate > dim) return;
        historyDaysByViewerId[id].add(actualDate);
        historyByViewerId[id][actualDate - 1] = Number(row?.adjusted_fan_gain_cumulative ?? 0);
      });

      const activeProfileViewerIds = friendProfiles
        .map((profile) => String(profile?.friend_viewer_id ?? ""))
        .filter((viewerId) => viewerId && activeRosterIds.has(viewerId));
      const sharedActualDate = activeProfileViewerIds.length
        ? Array.from({ length: dim }, (_, idx) => idx + 1).reduce((sharedMax, dayNum) => {
            const everyoneHasDay = activeProfileViewerIds.every((viewerId) => historyDaysByViewerId[viewerId]?.has(dayNum));
            return everyoneHasDay ? dayNum : sharedMax;
          }, 0)
        : 0;

      const members = friendProfiles.map((profile) => {
        const viewerId = profile?.friend_viewer_id;
        const rawHistoryCum = Array.isArray(historyByViewerId[viewerId]) ? [...historyByViewerId[viewerId]] : new Array(dim).fill(0);
        const historyDays = historyDaysByViewerId[viewerId] || new Set();
        const firstActualHistoryDay = historyDays.size ? Math.min(...historyDays) : 0;
        const lastActualHistoryDay = historyDaysByViewerId[viewerId]?.size ? Math.max(...historyDaysByViewerId[viewerId]) : 0;
        const rawCum = [...rawHistoryCum];
        for (let i = 1; i < rawCum.length; i++) {
          if (rawCum[i] < rawCum[i - 1]) rawCum[i] = rawCum[i - 1];
        }
        const dailySeries = buildDailyGainSeries(rawCum);
        const latestMonthlyGain = rawCum.reduce((last, value) => value > 0 ? value : last, 0);
        const latestDailyGain = (() => {
          const lastTrackedIdx = Math.max(0, (sharedActualDate || lastActualHistoryDay || dim) - 1);
          for (let i = Math.min(lastTrackedIdx, dailySeries.length - 1); i >= 0; i--) if ((dailySeries[i] ?? 0) > 0) return dailySeries[i];
          return profile?.daily_average ?? null;
        })();
        const positiveGainDays = dailySeries.slice(0, Math.max(sharedActualDate || lastActualHistoryDay, 0)).filter((value) => (value ?? 0) > 0).length;
        const elapsedProjectionDays = Math.max(positiveGainDays, Math.min(sharedActualDate || lastActualHistoryDay || 0, lastActualHistoryDay || 0));
        const projected = elapsedProjectionDays > 0 ? Math.round((latestMonthlyGain / elapsedProjectionDays) * dim) : null;
        return {
          viewerId: String(viewerId ?? ""),
          name: profile?.name || (Array.isArray(profile?.names) && profile.names[0]) || "Unknown",
          fans: Number(profile?.fan_count ?? 0),
          dailyGain: latestDailyGain ?? null,
          monthlyGain: latestMonthlyGain || 0,
          projected,
          isActive: activeRosterIds.has(String(viewerId)),
          historyDayCount: historyDays.size,
          firstActualHistoryDay,
          lastActualHistoryDay,
          observedHistoryDays: Array.from(historyDays).sort((a, b) => a - b),
          dailyFans: [],
          precomputedCumulativeSeries: rawCum,
          precomputedDailyGainSeries: dailySeries,
        };
      });

      const refreshedAt = safeIso(
        json?.refreshed_at ||
        json?.fetched_at ||
        json?.generated_at ||
        json?.meta?.refreshed_at ||
        json?.meta?.fetched_at ||
        json?.meta?.generated_at ||
        json?._meta?.refreshedAt ||
        json?._meta?.refreshed_at ||
        null
      );
      const sourceUpdatedAt = safeIso(clubRoot?.updated_at);
      const lastFetch = refreshedAt || sourceUpdatedAt || null;
      const archiveConfig = getArchiveFrontendConfig(json);
      return {
        members,
        clubName: clubRoot?.name || "Unknown",
        lastFetch,
        refreshedAt,
        sourceUpdatedAt,
        sourceType: DATA_SOURCE,
        archiveConfig,
        sharedActualDate,
        dataYear: datasetMonth.year,
        dataMonth: datasetMonth.month,
        datasetMonthKey: datasetMonth.key,
        archiveMonthKey: datasetMonth.key,
        clubDailyHistory: Array.isArray(json?.club_daily_history) ? json.club_daily_history : [],
        clubMonthlyHistory: Array.isArray(json?.club_monthly_history) ? json.club_monthly_history : [],
      };
    }

    function parseJSON(raw, dataDateOverride = null) {
      let json;
      try { json = typeof raw === "string" ? JSON.parse(raw.trim()) : raw; } catch (e) { return { error: "Invalid JSON: " + e.message }; }
      return parseChronogenesisJson(json, dataDateOverride);
    }

    function buildCumulativeSeries(dailyFans, dim) {
      const df = Array.isArray(dailyFans) ? dailyFans : [];
      const series = []; let baseline = null; let lastSeen = 0;
      for (let i = 0; i < dim; i++) {
        const raw = Number(df[i] ?? 0);
        if (baseline == null) { if (raw > 0) { baseline = raw; lastSeen = raw; series.push(0); } else { series.push(0); } continue; }
        if (raw > 0) lastSeen = raw;
        series.push(Math.max(0, lastSeen - baseline));
      }
      return series;
    }

    function getMonthWeeks(year, monthIndex) {
      const dim = daysInMonth(year, monthIndex + 1); const weeks = []; let day = 1;
      while (day <= dim) {
        const date = new Date(year, monthIndex, day); const weekday = date.getDay();
        const offsetToSaturday = (6 - weekday + 7) % 7; const endDay = Math.min(dim, day + offsetToSaturday);
        weeks.push({ index: weeks.length, number: weeks.length + 1, startDay: day, endDay, dayCount: endDay - day + 1 });
        day = endDay + 1;
      }
      return weeks;
    }

    function findWeekForDay(weeks, day) { return weeks.find((week) => day >= week.startDay && day <= week.endDay) || weeks[weeks.length - 1]; }
    function getDateLabel(year, monthIndex, day) { return new Date(year, monthIndex, day).toLocaleDateString("en-US", { month: "short", day: "numeric" }); }
    function getWeekLabel(week, year, monthIndex) { if (!week) return "—"; return `${getDateLabel(year, monthIndex, week.startDay)} – ${getDateLabel(year, monthIndex, week.endDay)}`; }

    function getPlanMetrics(monthlyGain, monthlyTarget, today, dim, weeks) {
      const safeGain = monthlyGain ?? 0; const dailyTarget = monthlyTarget > 0 ? monthlyTarget / dim : 0;
      const expectedToDate = Math.round(dailyTarget * today); const delta = safeGain - expectedToDate;
      const ratio = expectedToDate > 0 ? safeGain / expectedToDate : 1;
      let statusKey = "on-track";
      if (expectedToDate > 0 && ratio < 0.25) statusKey = "critical";
      else if (expectedToDate > 0 && ratio < 1) statusKey = "behind";
      const currentWeek = findWeekForDay(weeks, today);
      const currentWeekTarget = currentWeek ? Math.round(dailyTarget * currentWeek.dayCount) : 0;
      const currentWeekElapsedDays = currentWeek ? Math.max(0, today - currentWeek.startDay + 1) : 0;
      const currentWeekExpectedToDate = Math.round(dailyTarget * currentWeekElapsedDays);
      const currentWeekCheckpointTarget = currentWeek ? Math.round(dailyTarget * currentWeek.endDay) : expectedToDate;
      return { dailyTarget, expectedToDate, delta, ratio, statusKey, status: STATUS_META[statusKey].label, currentWeek, currentWeekTarget, currentWeekElapsedDays, currentWeekExpectedToDate, currentWeekCheckpointTarget };
    }

    function deltaText(delta) { if (delta == null) return "—"; if (delta === 0) return "0"; return fmtSigned(delta); }
    function buildDailyGainSeries(cumulativeSeries = []) { return cumulativeSeries.map((value, index) => value - (index > 0 ? (cumulativeSeries[index - 1] ?? 0) : 0)); }
    function buildDailyGainSeriesFromDailyFans(dailyFans = [], dim) {
      const df = Array.isArray(dailyFans) ? dailyFans : []; const series = []; let lastSeen = 0;
      for (let i = 0; i < dim; i++) { const raw = Number(df[i] ?? 0); if (raw > 0) { series.push(Math.max(0, raw - lastSeen)); lastSeen = raw; } else { series.push(0); } }
      return series;
    }
    function buildCumulativeFromDailyGainSeries(dailySeries = [], dim = dailySeries.length) {
      const safeDim = Math.max(0, dim || 0); const result = []; let running = 0;
      for (let i = 0; i < safeDim; i++) { running += Number(dailySeries[i] ?? 0); result.push(running); }
      return result;
    }

    function buildClubDailySeries(cdata, decorated = [], dim = 0) {
      if (Array.isArray(cdata?.clubDailyHistory) && cdata.clubDailyHistory.length) {
        const nextSeries = new Array(dim).fill(null);
        cdata.clubDailyHistory.forEach((row) => {
          const actualDate = Number(row?.actual_date);
          if (!Number.isFinite(actualDate) || actualDate < 1 || actualDate > dim) return;
          nextSeries[actualDate - 1] = Number(row?.interpolated_fan_gain ?? 0);
        });
        return { series: nextSeries, fromHistory: true };
      }
      return { series: Array.from({ length: dim }, (_, d) => decorated.reduce((s, m) => s + (m.dailyGainSeries[d] ?? 0), 0)), fromHistory: false };
    }


    function getMonthNumberKey(year, monthIndex) {
      return (Number(year) * 100) + Number(monthIndex + 1);
    }

    function getClubMonthlyHistoryRow(cdata, year, monthIndex) {
      const yearMonth = getMonthNumberKey(year, monthIndex);
      const rows = Array.isArray(cdata?.clubMonthlyHistory) ? cdata.clubMonthlyHistory : [];
      return rows.find((row) => Number(row?.year_month) === yearMonth) || null;
    }

    function getFinalClubMonthlyRank(cdata, year, monthIndex) {
      const monthlyRow = getClubMonthlyHistoryRow(cdata, year, monthIndex);
      const rank = Number(monthlyRow?.rank);
      return Number.isFinite(rank) && rank > 0 ? rank : null;
    }

    function getFinalClubMonthlyFanGain(cdata, year, monthIndex) {
      const monthlyRow = getClubMonthlyHistoryRow(cdata, year, monthIndex);
      const gain = Number(monthlyRow?.monthly_fan_gain);
      return Number.isFinite(gain) ? gain : null;
    }

    function buildClubDailyMetrics(cdata, decorated = [], dim = 0, today = 1) {
      const { series, fromHistory } = buildClubDailySeries(cdata, decorated, dim);
      const latestDailyIdx = Math.min(Math.max(today - 1, 0), Math.max(series.length - 1, 0));
      const totalDaily = latestDailyIdx >= 0 ? (series[latestDailyIdx] ?? null) : null;
      const previousDaily = latestDailyIdx > 0 ? (series[latestDailyIdx - 1] ?? null) : null;
      return {
        clubDailySeries: series,
        historyDailySeries: fromHistory ? series : null,
        totalDaily,
        previousDaily,
        dailyTrendDelta: totalDaily != null && previousDaily != null ? totalDaily - previousDaily : null,
      };
    }

    function normalizeMemberSeries(rawCumulativeSeries = [], member, dim, currentIdx) {
      const safeDim = Math.max(0, dim || rawCumulativeSeries.length || 0);
      const raw = Array.from({ length: safeDim }, (_, i) => Math.max(0, Number(rawCumulativeSeries[i] ?? 0)));
      const normalized = [...raw];
      const idx = Math.max(0, Math.min(currentIdx ?? (safeDim - 1), Math.max(0, safeDim - 1)));
      const targetCurrent = Math.max(0, Number(member?.monthlyGain ?? raw[idx] ?? 0));
      const rawCurrent = Math.max(0, Number(raw[idx] ?? 0));
      const targetDaily = member?.dailyGain == null ? null : Math.max(0, Number(member.dailyGain));
      if (!safeDim) return { cumulativeSeries: [], dailyGainSeries: [] };
      if (idx === 0) { normalized[0] = targetCurrent; }
      else {
        const prevTarget = targetDaily == null ? Math.max(0, Number(raw[idx - 1] ?? 0)) : Math.max(0, targetCurrent - targetDaily);
        const rawPrev = Math.max(0, Number(raw[idx - 1] ?? 0));
        if (rawPrev > 0) { const prefixFactor = prevTarget / rawPrev; for (let i = 0; i < idx; i++) normalized[i] = Math.max(0, Math.round(raw[i] * prefixFactor)); }
        else { for (let i = 0; i < idx - 1; i++) normalized[i] = 0; normalized[idx - 1] = prevTarget; }
        normalized[idx - 1] = prevTarget; normalized[idx] = targetCurrent;
      }
      const deltaFromRawCurrent = targetCurrent - rawCurrent;
      for (let i = idx + 1; i < safeDim; i++) normalized[i] = Math.max(targetCurrent, Math.round(Math.max(0, Number(raw[i] ?? 0)) + deltaFromRawCurrent));
      for (let i = 1; i < safeDim; i++) if (normalized[i] < normalized[i - 1]) normalized[i] = normalized[i - 1];
      const daily = buildDailyGainSeries(normalized);
      if (targetDaily != null) { daily[idx] = targetDaily; if (idx === 0) normalized[0] = targetCurrent; else { normalized[idx - 1] = Math.max(0, targetCurrent - targetDaily); normalized[idx] = targetCurrent; } }
      return { cumulativeSeries: normalized, dailyGainSeries: buildDailyGainSeries(normalized) };
    }

    function getTrailingAverage(values = [], endIndex = null, windowSize = 3) {
      if (!values.length) return 0;
      const finalIndex = Math.max(0, Math.min(values.length - 1, endIndex == null ? values.length - 1 : endIndex));
      const slice = values.slice(Math.max(0, finalIndex - windowSize + 1), finalIndex + 1);
      if (!slice.length) return 0;
      return Math.round(slice.reduce((sum, value) => sum + (value || 0), 0) / slice.length);
    }

    async function svgToPngBlob(svgEl, scale = 2) {
      if (!svgEl) return null;
      const clone = svgEl.cloneNode(true);
      clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
      clone.setAttribute("xmlns:xlink", "http://www.w3.org/1999/xlink");
      const viewBox = svgEl.viewBox?.baseVal;
      const width = viewBox?.width || svgEl.clientWidth || 980;
      const height = viewBox?.height || svgEl.clientHeight || 360;
      const svgString = new XMLSerializer().serializeToString(clone);
      const svgBlob = new Blob([svgString], { type: "image/svg+xml;charset=utf-8" });
      const svgUrl = URL.createObjectURL(svgBlob);
      try {
        const img = await new Promise((resolve, reject) => { const nextImg = new Image(); nextImg.onload = () => resolve(nextImg); nextImg.onerror = reject; nextImg.src = svgUrl; });
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(width * scale)); canvas.height = Math.max(1, Math.round(height * scale));
        const ctx = canvas.getContext("2d"); ctx.fillStyle = "#0a0912"; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        return await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
      } finally { URL.revokeObjectURL(svgUrl); }
    }

    function downloadBlob(blob, filename) {
      if (!blob) return; const url = URL.createObjectURL(blob); const a = document.createElement("a");
      a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    function safeFilename(value) { return String(value || "graph").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "graph"; }

    function ProgressBar({ pct, color = "#7c3aed", height = 8 }) {
      return (<div style={{ background: "#1a1730", borderRadius: 99, height, overflow: "hidden", width: "100%" }}><div style={{ width: `${Math.min(100, Math.max(0, pct || 0))}%`, height: "100%", background: color, borderRadius: 99, transition: "width 0.5s ease" }} /></div>);
    }

    function TierBadge({ tier, size = 22, rankingConfig = RANKING_CONFIG, rankIconPath = RANK_ICON_PATH }) {
      return (
        <span style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", minWidth: size, minHeight: size, lineHeight: 1, flex: "0 0 auto" }}>
          <TierIcon tier={tier} size={size} title={`${tier} tier`} showFallbackText={true} rankingConfig={rankingConfig} rankIconPath={rankIconPath} />
        </span>
      );
    }

    function RankDeltaIndicator({ delta }) {
      if (delta == null) return null;
      if (delta === 0) return (<span style={{ color: "#f97316", fontSize: 11, fontWeight: 700, display: "inline-flex", alignItems: "center", gap: 2 }}>— 0</span>);
      const isUp = delta > 0;
      return (<span style={{ color: isUp ? "#34d399" : "#f87171", fontSize: 11, fontWeight: 700, display: "inline-flex", alignItems: "center", gap: 2 }}>{isUp ? "▲" : "▼"} {Math.abs(delta).toLocaleString()}</span>);
    }

    function DailyTrendIndicator({ delta }) {
      if (delta == null) return (<span style={{ color: "#6b7280", fontSize: 10, fontWeight: 700 }}>—</span>);
      if (delta === 0) return (<span style={{ color: "#f59e0b", fontSize: 10, fontWeight: 700 }}>→ 0</span>);
      const isUp = delta > 0;
      return (<span style={{ color: isUp ? "#34d399" : "#f87171", fontSize: 10, fontWeight: 700, display: "inline-flex", alignItems: "center", gap: 4 }}>{isUp ? "▲" : "▼"} {fmt(Math.abs(delta))}</span>);
    }

    function MonthlyRankBadge({ rank, delta, size = "normal", rankingConfig = RANKING_CONFIG, rankIconPath = RANK_ICON_PATH }) {
      if (rank == null) return null;
      const currentTier = getTierForRank(rank, rankingConfig);
      const isSmall = size === "small";
      const iconSize = isSmall ? 16 : 20;
      return (
        <span style={{ display: "inline-flex", alignItems: "center", gap: isSmall ? 4 : 6, lineHeight: 1 }}>
          {currentTier && <TierIcon tier={currentTier} size={iconSize} title={`${currentTier} rank tier`} showFallbackText={true} rankingConfig={rankingConfig} rankIconPath={rankIconPath} />}
          <span style={{ color: "#e2e0f0", fontWeight: 800, fontSize: isSmall ? 11 : 12, whiteSpace: "nowrap" }}>#{rank.toLocaleString()}</span>
          <RankDeltaIndicator delta={delta} />
        </span>
      );
    }

    function StatusBadge({ statusKey }) {
      const meta = STATUS_META[statusKey] || STATUS_META["behind"];
      return (<span style={{ background: meta.bg, border: `1px solid ${meta.border}`, color: meta.color, borderRadius: 6, padding: "2px 8px", fontSize: 10, fontWeight: 800, whiteSpace: "nowrap" }}>{meta.icon} {meta.label}</span>);
    }

    function HealthBadge({ grade }) {
      const g = HEALTH_GRADES.find((h) => h.grade === grade) || HEALTH_GRADES[HEALTH_GRADES.length - 1];
      return (<span style={{ background: g.bg, border: `1px solid ${g.color}66`, color: g.color, borderRadius: 6, padding: "2px 10px", fontSize: 13, fontWeight: 900, letterSpacing: "0.04em" }}>{grade}</span>);
    }

    function HealthScoreComponent({ label, ratio = 0, weight = 0, accent = "#7c3aed", helper = "" }) {
      const normalizedRatio = clamp01(ratio);
      const weightPoints = Math.round(weight * 100);
      const contributionPoints = Math.round(normalizedRatio * weight * 100);
      return (
        <div style={{ background: "#0c0b18", border: "1px solid #1e1b35", borderRadius: 10, padding: "10px 10px 9px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "baseline", marginBottom: 6 }}>
            <div style={{ color: "#c7c4dd", fontSize: 11, fontWeight: 700 }}>{label}</div>
            <div style={{ color: accent, fontSize: 11, fontWeight: 800, whiteSpace: "nowrap" }}>{Math.round(normalizedRatio * 100)}% · {contributionPoints}/{weightPoints} pts</div>
          </div>
          <div style={{ marginBottom: 6 }}><ProgressBar pct={normalizedRatio * 100} color={accent} height={5} /></div>
          <div style={{ color: "#6b7280", fontSize: 10, lineHeight: 1.35 }}>{helper} · Weight {weightPoints}%</div>
        </div>
      );
    }

    function StagnantBadge({ days }) {
      if (days < 2) return null;
      const color = days >= 5 ? "#f87171" : days >= 3 ? "#f97316" : "#fbbf24";
      return (<span style={{ background: color + "22", border: `1px solid ${color}44`, color, borderRadius: 6, padding: "1px 6px", fontSize: 9, fontWeight: 700, whiteSpace: "nowrap" }}>⏸ {days}d idle</span>);
    }

    function DaysToTargetBadge({ days, daysLeft }) {
      if (days === Infinity || days == null) return (<span style={{ color: "#f87171", fontSize: 10, fontWeight: 700 }}>∞</span>);
      const color = days > daysLeft ? "#f87171" : days > daysLeft * 0.8 ? "#fbbf24" : "#34d399";
      return (<span style={{ color, fontWeight: 700 }}>{days}d</span>);
    }

    function getVisibleCumulativeSparklineValues(data = [], visibleDayCount = null) {
      const dayCount = Number.isFinite(visibleDayCount) ? Math.max(0, Math.floor(visibleDayCount)) : data.length;
      const boundedValues = data.slice(0, dayCount);
      const values = [];
      let lastKnownValue = null;

      boundedValues.forEach((rawValue) => {
        const value = Number(rawValue);
        if (Number.isFinite(value) && value > 0) {
          lastKnownValue = lastKnownValue == null ? value : Math.max(lastKnownValue, value);
          values.push(lastKnownValue);
        } else if (lastKnownValue != null) {
          values.push(lastKnownValue);
        }
      });

      return values;
    }

    function Sparkline({ data = [], visibleDayCount = null, width = 90, height = 26, color = "#7c3aed" }) {
      const vals = getVisibleCumulativeSparklineValues(data, visibleDayCount);
      if (vals.length < 2) return <span style={{ color: "#4b5563", fontSize: 10 }}>—</span>;
      const min = Math.min(...vals); const max = Math.max(...vals); const range = max - min || 1; const step = width / (vals.length - 1);
      const pts = vals.map((v, i) => `${i * step},${height - ((v - min) / range) * (height - 4) - 2}`).join(" ");
      const lx = (vals.length - 1) * step; const ly = height - ((vals[vals.length - 1] - min) / range) * (height - 4) - 2;
      return (<svg width={width} height={height}><polyline className="chart-line" pathLength="1" points={pts} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" /><circle cx={lx} cy={ly} r={2.5} fill={color} opacity={0.8} /></svg>);
    }

    function PaceChart({ seriesList = [], targetSeries = [], weeks = [], year, monthIndex, svgRef, zoom = 1, pinnedIdx, setPinnedIdx, containerRef, currentDayIdx = 0, mode = "cumulative" }) {
      const [hoverIdx, setHoverIdx] = useState(null);
      const isPinned = pinnedIdx != null;
      const clampedCurrentDayIdx = Math.max(0, Math.min(currentDayIdx, Math.max(0, targetSeries.length - 1)));
      const visibleDayCount = Math.max(1, clampedCurrentDayIdx + 1);
      const fullTargetSeries = targetSeries || [];
      const visibleTargetSeries = fullTargetSeries.slice(0, visibleDayCount);
      const drawnSeriesList = seriesList.map((item) => ({ ...item, series: (item.series || []).slice(0, visibleDayCount) }));
      const effectiveIdx = isPinned ? Math.max(0, Math.min(pinnedIdx, Math.max(0, fullTargetSeries.length - 1))) : hoverIdx;
      if (!fullTargetSeries.length) return (<div style={{ color: "#6b7280", fontSize: 12, padding: "18px 0" }}>Not enough daily data to render the pace chart yet.</div>);
      const width = 980, height = 360;
      const padding = { top: 24, right: 28, bottom: 42, left: 62 };
      const innerW = width - padding.left - padding.right, innerH = height - padding.top - padding.bottom;
      const dayCount = fullTargetSeries.length;
      const allValues = [...fullTargetSeries, ...drawnSeriesList.flatMap((item) => item.series || [])];
      const maxVal = Math.max(...allValues, 1);
      const currentX = padding.left + (dayCount <= 1 ? 0 : ((visibleDayCount - 1) / (dayCount - 1)) * innerW);
      const xForIndex = (index) => padding.left + (dayCount <= 1 ? 0 : (index / (dayCount - 1)) * innerW);
      const yForValue = (value) => padding.top + innerH - ((value || 0) / maxVal) * innerH;
      const pathFor = (series) => series.map((value, index) => `${index === 0 ? "M" : "L"} ${xForIndex(index)} ${yForValue(value)}`).join(" ");
      const gridValues = Array.from({ length: 5 }, (_, index) => Math.round((maxVal / 4) * index));
      const hoverMembers = effectiveIdx != null ? [...drawnSeriesList].map((item) => { const value = effectiveIdx < visibleDayCount ? (item.series?.[effectiveIdx] ?? null) : null; const target = fullTargetSeries[effectiveIdx] ?? 0; return { ...item, value, delta: value == null ? null : value - target }; }).sort((a, b) => (b.value ?? Number.NEGATIVE_INFINITY) - (a.value ?? Number.NEGATIVE_INFINITY)) : [];
      const hover = effectiveIdx != null ? { day: effectiveIdx + 1, target: fullTargetSeries[effectiveIdx] ?? 0, x: xForIndex(effectiveIdx), yTarget: yForValue(fullTargetSeries[effectiveIdx] ?? 0) } : null;
      const tooltipLeftPct = hover ? Math.max(14, Math.min(86, (hover.x / width) * 100)) : 50;
      const tooltipTranslateX = tooltipLeftPct > 78 ? "-100%" : tooltipLeftPct < 22 ? "0" : "-50%";
      const modeLabel = mode === "daily" ? "Daily gain" : "Cumulative gain";
      const targetLabel = mode === "daily" ? "Daily plan guideline" : "Cumulative plan guideline";
      return (
        <div ref={containerRef} style={{ position: "relative", overflow: "visible", background: "transparent" }}>
          <div style={{ overflowX: "auto", paddingBottom: 6 }}>
            <svg ref={svgRef} viewBox={`0 0 ${width} ${height}`} style={{ width: `${Math.max(100, zoom * 100)}%`, minWidth: `${Math.round(width * Math.max(1, zoom))}px`, height: "auto", display: "block" }}>
              {gridValues.map((value, index) => { const y = yForValue(value); return (<g key={index}><line x1={padding.left} x2={width - padding.right} y1={y} y2={y} stroke="#1e1b35" strokeDasharray="4 4" /><text x={padding.left - 10} y={y + 4} textAnchor="end" fill="#6b7280" fontSize="10">{fmt(value)}</text></g>); })}
              {weeks.filter((week) => week.startDay <= dayCount).map((week) => { const boundaryDay = Math.min(week.endDay, dayCount); const x = xForIndex(boundaryDay - 1); return (<g key={week.number}><line x1={x} x2={x} y1={padding.top} y2={height - padding.bottom} stroke="#2a2540" strokeDasharray="3 5" /><text x={Math.max(padding.left + 12, x - 4)} y={padding.top + 12} textAnchor="end" fill="#6b7280" fontSize="10">W{week.number}</text></g>); })}
              <path d={pathFor(fullTargetSeries)} fill="none" stroke="#c4b5fd" strokeWidth="2.5" strokeDasharray="7 6" />
              {drawnSeriesList.map((item) => (<path key={`${item.name}-${mode}-${visibleDayCount}`} className="chart-line" pathLength="1" d={pathFor(item.series)} fill="none" stroke={item.color} strokeWidth="2" opacity="0.9" />))}
              <g><circle cx={currentX} cy={yForValue(fullTargetSeries[visibleDayCount - 1] ?? 0)} r="3.8" fill="#c4b5fd" style={{ filter: "drop-shadow(0 0 5px rgba(196,181,253,0.9))" }} /></g>
              {drawnSeriesList.map((item) => { const currentValue = item.series?.[visibleDayCount - 1] ?? 0; return (<g key={`${item.name}-current-dot`}><circle cx={currentX} cy={yForValue(currentValue)} r="3.2" fill={item.color} stroke="#0a0912" strokeWidth="1" style={{ filter: `drop-shadow(0 0 4px ${item.color})` }} /></g>); })}
              {hover && (<><line x1={hover.x} x2={hover.x} y1={padding.top} y2={height - padding.bottom} stroke={isPinned ? "#a78bfa" : "#7c3aed"} strokeWidth={isPinned ? "2" : "1"} strokeDasharray="2 4" /><circle cx={hover.x} cy={hover.yTarget} r="4" fill="#c4b5fd" />{hoverMembers.filter((item) => item.value != null).map((item) => (<circle key={item.name} cx={hover.x} cy={yForValue(item.value)} r="3" fill={item.color} stroke="#0a0912" strokeWidth="1" />))}</>)}
              {Array.from({ length: dayCount }, (_, index) => { const startX = index === 0 ? padding.left : (xForIndex(index - 1) + xForIndex(index)) / 2; const endX = index === dayCount - 1 ? width - padding.right : (xForIndex(index) + xForIndex(index + 1)) / 2; return (<g key={index}><rect x={startX} y={padding.top} width={Math.max(10, endX - startX)} height={innerH} fill="transparent" style={{ cursor: "pointer" }} onMouseEnter={() => { if (!isPinned) setHoverIdx(index); }} onMouseLeave={() => { if (!isPinned) setHoverIdx(null); }} onClick={() => { if (isPinned && pinnedIdx === index) setPinnedIdx(null); else setPinnedIdx(index); }} />{(index === 0 || index === dayCount - 1 || ((index + 1) % 5 === 0)) && (<text x={xForIndex(index)} y={height - padding.bottom + 18} textAnchor="middle" fill="#6b7280" fontSize="10">{index + 1}</text>)}</g>); })}
            </svg>
          </div>
          {hover && (<div style={{ position: "absolute", left: `${tooltipLeftPct}%`, top: 8, transform: `translateX(${tooltipTranslateX})`, background: "linear-gradient(168deg, rgba(34,29,66,0.97), rgba(14,12,30,0.98))", border: `1px solid ${isPinned ? "#a78bfa" : "rgba(167,139,250,0.32)"}`, borderRadius: 12, padding: "11px 13px", minWidth: 330, width: "max-content", maxWidth: "min(92vw, 620px)", boxShadow: isPinned ? "0 1px 0 rgba(226,224,240,0.06) inset, 0 18px 44px rgba(124,58,237,0.3)" : "0 1px 0 rgba(226,224,240,0.06) inset, 0 18px 44px rgba(3,2,10,0.65)", pointerEvents: isPinned ? "auto" : "none", zIndex: 5, overflow: "visible" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, marginBottom: 7 }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 7 }}>
                <span className="telemetry" style={{ color: "#f1eefc", fontWeight: 700, fontSize: 13 }}>Day {hover.day}</span>
                <span style={{ color: "#8f88b8", fontSize: 10, fontWeight: 700 }}>{getDateLabel(year, monthIndex, hover.day)}</span>
              </div>
              {isPinned && (<span style={{ color: "#a78bfa", fontSize: 10, fontWeight: 700, display: "inline-flex", alignItems: "center", gap: 4, background: "#a78bfa22", border: "1px solid #a78bfa44", borderRadius: 999, padding: "2px 8px", cursor: "pointer" }} onClick={() => setPinnedIdx(null)}>📌 Pinned — unpin</span>)}
            </div>
            <div style={{ display: "inline-flex", alignItems: "center", gap: 6, marginBottom: 9, padding: "3px 9px", borderRadius: 999, background: "rgba(196,181,253,0.1)", border: "1px solid rgba(196,181,253,0.3)" }}>
              <span style={{ width: 12, height: 0, borderTop: "2.5px dashed #c4b5fd", display: "inline-block" }} />
              <span style={{ color: "#c4b5fd", fontSize: 10.5, fontWeight: 700 }}>{targetLabel}: {fmt(hover.target)}</span>
            </div>
            {hoverMembers.length === 0 ? (<div style={{ color: "#6b7280", fontSize: 11 }}>Turn on at least one member card to compare lines against the plan.</div>) : (hoverMembers.map((item, idx) => {
              const ps = getPodiumStyle(idx);
              const ahead = item.delta != null && item.delta >= 0;
              const barPct = item.value == null || hover.target <= 0 ? null : Math.min(100, Math.max(0, (item.value / hover.target) * 100));
              return (
                <div key={item.name} style={{ marginBottom: 6 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 14, alignItems: "center", fontSize: 11, whiteSpace: "nowrap" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0 }}>
                      <span className="telemetry" style={{ color: ps.color, textShadow: ps.textShadow, fontSize: 10, fontWeight: 700, minWidth: 16, textAlign: "right" }}>{item.value == null ? "·" : `P${idx + 1}`}</span>
                      <span style={{ width: 8, height: 8, borderRadius: 999, background: item.color, flexShrink: 0, boxShadow: `0 0 7px ${item.color}` }} />
                      <span style={{ color: "#f1eefc", fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis" }}>{item.name}</span>
                    </div>
                    <div style={{ textAlign: "right", display: "flex", alignItems: "center", gap: 7 }}>
                      <span style={{ color: item.value == null ? "#6b7280" : "#f1eefc", fontWeight: 800 }}>{fmt(item.value)}</span>
                      <span style={{ color: item.delta == null ? "#6b7280" : ahead ? "#34d399" : "#f87171", fontWeight: 700, fontSize: 10, background: item.delta == null ? "transparent" : ahead ? "rgba(52,211,153,0.12)" : "rgba(248,113,113,0.12)", border: item.delta == null ? "none" : `1px solid ${ahead ? "rgba(52,211,153,0.35)" : "rgba(248,113,113,0.35)"}`, borderRadius: 999, padding: "1px 7px", minWidth: 58, display: "inline-block" }}>{fmtSigned(item.delta)}</span>
                    </div>
                  </div>
                  {mode === "cumulative" && barPct != null && (
                    <div style={{ marginTop: 3, marginLeft: 31, height: 3, borderRadius: 99, background: "rgba(167,139,250,0.12)", overflow: "hidden" }}>
                      <div style={{ width: `${barPct}%`, height: "100%", borderRadius: 99, background: `linear-gradient(90deg, ${item.color}, ${ahead ? "#34d399" : "#f87171"})` }} />
                    </div>
                  )}
                </div>
              );
            }))}
          </div>)}
          <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginTop: 10, color: "#9ca3af", fontSize: 11 }}><span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><span style={{ width: 14, height: 3, background: "#c4b5fd", borderRadius: 99, display: "inline-block" }} />{targetLabel}</span>{drawnSeriesList.map((item) => (<span key={item.name} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><span style={{ width: 14, height: 3, background: item.color, borderRadius: 99, display: "inline-block" }} />{item.name}</span>))}</div>
        </div>
      );
    }


    class AppErrorBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { error: null };
      }
      static getDerivedStateFromError(error) {
        return { error };
      }
      componentDidCatch(error, info) {
        console.error('App render error:', error, info);
      }
      render() {
        if (this.state.error) {
          return (
            <div style={{ background: '#0a0912', color: '#e2e0f0', minHeight: '100vh', padding: 24, fontFamily: "'Inter',system-ui,sans-serif" }}>
              <div style={{ maxWidth: 980, margin: '0 auto', background: '#111028', border: '1px solid #7f1d1d', borderRadius: 14, padding: 18 }}>
                <div style={{ color: '#fca5a5', fontWeight: 800, fontSize: 18, marginBottom: 10 }}>The tracker hit a render error.</div>
                <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: '#fca5a5', fontSize: 12 }}>{String(this.state.error?.stack || this.state.error)}</pre>
              </div>
            </div>
          );
        }
        return this.props.children;
      }
    }

    window.addEventListener('error', (event) => {
      console.error('Window error:', event.error || event.message);
    });
    window.addEventListener('unhandledrejection', (event) => {
      console.error('Unhandled promise rejection:', event.reason);
    });

    function NetworkPaceChart({ clubs = [], dim, today, mode = "cumulative", currentDayIdx = 0 }) {
      const [hoverIdx, setHoverIdx] = useState(null);
      const visibleDayCount = Math.max(1, Math.min(dim, currentDayIdx + 1));
      const targetSeries = mode === "daily" ? Array.from({ length: dim }, () => 100 / Math.max(dim, 1)) : Array.from({ length: dim }, (_, i) => ((i + 1) / Math.max(dim, 1)) * 100);
      const visibleTargetSeries = targetSeries.slice(0, visibleDayCount);
      const lines = clubs.map((club) => ({ ...club, series: (mode === "daily" ? club.clubDailyPctSeries : club.clubPctSeries || []).slice(0, visibleDayCount) })).filter((club) => club.series && club.series.length > 0);
      const allLineSeries = clubs.map((club) => ({ ...club, series: mode === "daily" ? club.clubDailyPctSeries : club.clubPctSeries || [] }));
      if (!lines.length) return (<div style={{ color: "#6b7280", fontSize: 12, padding: "18px 0" }}>No club data available for the network pace chart.</div>);
      const W = 980, H = 320, pad = { top: 24, right: 28, bottom: 42, left: 55 };
      const innerW = W - pad.left - pad.right, innerH = H - pad.top - pad.bottom;
      const allValues = [...targetSeries, ...lines.flatMap((l) => l.series || [])];
      const baseMax = mode === "daily" ? Math.max((100 / Math.max(dim, 1)) * 2, 1) : 120;
      const maxV = Math.max(baseMax, ...allValues);
      const xI = (i) => pad.left + (dim <= 1 ? 0 : (i / (dim - 1)) * innerW);
      const yV = (v) => pad.top + innerH - ((v || 0) / maxV) * innerH;
      const pathFor = (s) => s.map((v, i) => `${i === 0 ? "M" : "L"} ${xI(i)} ${yV(v)}`).join(" ");
      const gridVals = mode === "daily" ? Array.from({ length: 5 }, (_, index) => Number(((maxV / 4) * index).toFixed(2))) : [0, 25, 50, 75, 100];
      const currentX = xI(visibleDayCount - 1);
      const targetLabel = mode === "daily" ? "Daily target pace" : "Cumulative target pace";
      return (
        <div style={{ position: "relative" }}>
          <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto", display: "block" }}>
            {gridVals.map((v) => { const y = yV(v); return (<g key={v}><line x1={pad.left} x2={W - pad.right} y1={y} y2={y} stroke="#1e1b35" strokeDasharray="4 4" /><text x={pad.left - 8} y={y + 4} textAnchor="end" fill="#6b7280" fontSize="10">{mode === "daily" ? `${v.toFixed(2)}%` : `${v}%`}</text></g>); })}
            <path d={pathFor(targetSeries)} fill="none" stroke="#c4b5fd" strokeWidth="2.5" strokeDasharray="7 6" />
            {lines.map((l) => (<path key={`${l.name}-${mode}-${visibleDayCount}`} className="chart-line" pathLength="1" d={pathFor(l.series)} fill="none" stroke={l.clubColor} strokeWidth="2.5" opacity="0.85" />))}
            <circle cx={currentX} cy={yV(targetSeries[visibleDayCount - 1] ?? 0)} r="4" fill="#c4b5fd" style={{ filter: "drop-shadow(0 0 5px rgba(196,181,253,0.9))" }} />
            {lines.map((l) => (<circle key={`${l.name}-current`} cx={currentX} cy={yV(l.series[visibleDayCount - 1] ?? 0)} r="3.5" fill={l.clubColor} stroke="#0a0912" strokeWidth="1" style={{ filter: `drop-shadow(0 0 4px ${l.clubColor})` }} />))}
            {hoverIdx != null && (<line x1={xI(hoverIdx)} x2={xI(hoverIdx)} y1={pad.top} y2={H - pad.bottom} stroke="#7c3aed" strokeDasharray="2 4" />)}
            {Array.from({ length: dim }, (_, i) => { const sx = i === 0 ? pad.left : (xI(i - 1) + xI(i)) / 2; const ex = i === dim - 1 ? W - pad.right : (xI(i) + xI(i + 1)) / 2; return (<rect key={i} x={sx} y={pad.top} width={Math.max(10, ex - sx)} height={innerH} fill="transparent" onMouseEnter={() => setHoverIdx(i)} onMouseLeave={() => setHoverIdx(null)} />); })}
            {hoverIdx != null && lines.filter((l) => hoverIdx < visibleDayCount).map((l) => (<circle key={l.name} cx={xI(hoverIdx)} cy={yV(l.series[hoverIdx] ?? 0)} r="4" fill={l.clubColor} stroke="#0a0912" strokeWidth="1" />))}
            {Array.from({ length: dim }, (_, i) => (i === 0 || i === dim - 1 || ((i + 1) % 5 === 0)) ? (<text key={i} x={xI(i)} y={H - pad.bottom + 18} textAnchor="middle" fill="#6b7280" fontSize="10">{i + 1}</text>) : null)}
          </svg>
          {hoverIdx != null && (() => {
            const isLive = hoverIdx < visibleDayCount;
            const rows = [...allLineSeries]
              .map((l) => {
                const pct = isLive ? (l.series?.[hoverIdx] ?? null) : null;
                const abs = isLive ? ((mode === "daily" ? l.clubDailySeries : l.clubCumSeries)?.[hoverIdx] ?? null) : null;
                return { ...l, pct, abs };
              })
              .sort((a, b) => (b.pct ?? Number.NEGATIVE_INFINITY) - (a.pct ?? Number.NEGATIVE_INFINITY));
            const target = targetSeries[hoverIdx] ?? 0;
            const totalAbs = rows.reduce((s, r) => s + (r.abs ?? 0), 0);
            const totalTarget = rows.reduce((s, r) => s + (Number(r.clubTarget) || 0), 0);
            const totalPct = totalTarget > 0 ? (totalAbs / totalTarget) * 100 : null;
            return (
              <div style={{ position: "absolute", left: `${Math.max(14, Math.min(86, (xI(hoverIdx) / W) * 100))}%`, top: 8, transform: "translateX(-50%)", background: "linear-gradient(168deg, rgba(34,29,66,0.97), rgba(14,12,30,0.98))", border: "1px solid rgba(167,139,250,0.32)", borderRadius: 12, padding: "10px 12px", minWidth: 330, boxShadow: "0 1px 0 rgba(226,224,240,0.06) inset, 0 18px 44px rgba(3,2,10,0.65)", pointerEvents: "none", zIndex: 5 }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 12, marginBottom: 7 }}>
                  <div style={{ color: "#e2e0f0", fontWeight: 800, fontSize: 12 }}>Day {hoverIdx + 1}</div>
                  <div style={{ color: "#c4b5fd", fontSize: 11, fontWeight: 700 }}>{targetLabel}: {mode === "daily" ? `${(target ?? 0).toFixed(2)}%` : `${Math.round(target ?? 0)}%`}</div>
                </div>
                {rows.map((l) => {
                  const onPace = l.pct != null && l.pct >= target;
                  return (
                    <div key={l.name} style={{ marginBottom: 6 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", gap: 14, fontSize: 11 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 6, color: "#e2e0f0", minWidth: 0 }}><span style={{ width: 8, height: 8, borderRadius: 999, background: l.clubColor, flexShrink: 0, boxShadow: `0 0 7px ${l.clubColor}` }} />{l.clubName} <TierBadge tier={l.tier} /></div>
                        <div style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                          <span style={{ color: l.abs == null ? "#6b7280" : "#e2e0f0", fontWeight: 800 }} title={l.abs == null ? "" : `${fmtFull(l.abs)} fans ${mode === "daily" ? "gained this day" : "gained so far"}`}>{l.abs == null ? "—" : fmt(l.abs)}</span>
                          <span style={{ color: l.pct == null ? "#6b7280" : onPace ? "#34d399" : "#f87171", fontWeight: 700, marginLeft: 7 }}>{l.pct == null ? "—" : (mode === "daily" ? `${l.pct.toFixed(2)}%` : `${l.pct.toFixed(1)}%`)}</span>
                        </div>
                      </div>
                      {mode === "cumulative" && l.pct != null && (
                        <div style={{ marginTop: 3, height: 3, borderRadius: 99, background: "rgba(167,139,250,0.12)", overflow: "hidden" }}>
                          <div style={{ width: `${Math.min(100, Math.max(0, l.pct))}%`, height: "100%", borderRadius: 99, background: `linear-gradient(90deg, ${l.clubColor}, ${onPace ? "#34d399" : "#f87171"})` }} />
                        </div>
                      )}
                    </div>
                  );
                })}
                <div style={{ display: "flex", justifyContent: "space-between", gap: 14, fontSize: 11, marginTop: 7, paddingTop: 7, borderTop: "1px solid rgba(167,139,250,0.22)" }}>
                  <div style={{ color: "#c4b5fd", fontWeight: 800 }}>⬡ Network total</div>
                  <div style={{ whiteSpace: "nowrap" }}>
                    <span style={{ color: "#e2e0f0", fontWeight: 800 }} title={`${fmtFull(totalAbs)} fans across all clubs`}>{isLive ? fmt(totalAbs) : "—"}</span>
                    {totalPct != null && isLive && <span style={{ color: totalPct >= target ? "#34d399" : "#f87171", fontWeight: 700, marginLeft: 7 }}>{mode === "daily" ? `${totalPct.toFixed(2)}%` : `${totalPct.toFixed(1)}%`}</span>}
                  </div>
                </div>
              </div>
            );
          })()}
          <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginTop: 10, color: "#9ca3af", fontSize: 11 }}><span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><span style={{ width: 14, height: 3, background: "#c4b5fd", borderRadius: 99, display: "inline-block" }} />{targetLabel}</span>{lines.map((l) => (<span key={l.name} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><span style={{ width: 14, height: 3, background: l.clubColor, borderRadius: 99, display: "inline-block" }} />{l.clubName}</span>))}</div>
        </div>
      );
    }


    function NetworkRankChart({ clubs = [], dim, effectiveGameDayKey, rankHistory, rankingConfig = RANKING_CONFIG, rankIconPath = RANK_ICON_PATH }) {
      const [hoverIdx, setHoverIdx] = useState(null);
      const effectiveRankDayNumber = Math.max(1, Math.min(dim, dateKeyToLocalDate(effectiveGameDayKey).getDate()));
      const dateKeyForDay = (dayNum) => {
        const [y, m] = effectiveGameDayKey.split("-").map(Number);
        return formatDateKey(y, m, dayNum);
      };
      const clubLines = clubs.filter((c) => c.id && rankHistory[c.id]).map((c) => {
        const hist = rankHistory[c.id];
        const series = [];
        for (let d = 1; d <= dim; d++) {
          const shouldDisplayDay = d <= effectiveRankDayNumber;
          series.push(shouldDisplayDay ? (hist[dateKeyForDay(d)]?.rank ?? null) : null);
        }
        return { ...c, rankSeries: series, clubColor: c.clubColor || getClubColor(clubs.indexOf(c)) };
      }).filter((c) => c.rankSeries.some((v) => v != null));
      if (!clubLines.length) return (<div style={{ color: "#6b7280", fontSize: 12, padding: "18px 0" }}>No rank history data available yet.</div>);
      const allRanks = clubLines.flatMap((c) => c.rankSeries.filter((v) => v != null));
      const minRank = Math.min(...allRanks);
      const maxRank = Math.max(...allRanks);
      const sortedTiers = [...(Array.isArray(rankingConfig) && rankingConfig.length ? rankingConfig : RANKING_CONFIG)].sort((a, b) => a.min - b.min);
      let topTierIdx = sortedTiers.findIndex((t) => minRank >= t.min && (t.max === null || minRank <= t.max));
      let botTierIdx = sortedTiers.findIndex((t) => maxRank >= t.min && (t.max === null || maxRank <= t.max));
      if (topTierIdx < 0) topTierIdx = 0;
      if (botTierIdx < 0) botTierIdx = sortedTiers.length - 1;
      topTierIdx = Math.max(0, topTierIdx - 1);
      botTierIdx = Math.min(sortedTiers.length - 1, botTierIdx + 1);
      const visibleTiers = sortedTiers.slice(topTierIdx, botTierIdx + 1);
      const yMinR = visibleTiers[0].min;
      const yMaxR = visibleTiers[visibleTiers.length - 1].max ?? (visibleTiers[visibleTiers.length - 1].min * 2);
      const W = 980, H = 400, pad = { top: 30, right: 28, bottom: 42, left: 80 };
      const innerW = W - pad.left - pad.right, innerH = H - pad.top - pad.bottom;
      const logMin = Math.log10(Math.max(1, yMinR));
      const logMax = Math.log10(Math.max(2, yMaxR));
      const logRange = logMax - logMin || 1;
      const xI = (i) => pad.left + (dim <= 1 ? 0 : (i / (dim - 1)) * innerW);
      const yV = (rank) => { if (rank == null) return null; return pad.top + ((Math.log10(Math.max(1, rank)) - logMin) / logRange) * innerH; };
      const buildPath = (series) => { let p = "", drawing = false; for (let i = 0; i < series.length; i++) { const y = yV(series[i]); if (y == null) { drawing = false; continue; } p += drawing ? `L ${xI(i)} ${y} ` : `M ${xI(i)} ${y} `; drawing = true; } return p; };
      const tierBounds = visibleTiers.map((t) => ({ tier: t.tier, rank: t.min, y: yV(t.min), icon: t.icon }));
      const latestDay = Math.max(0, effectiveRankDayNumber - 1);
      return (
        <div style={{ position: "relative" }}>
          <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto", display: "block" }}>
            {tierBounds.map((tb) => (<g key={tb.tier}><line x1={pad.left} x2={W - pad.right} y1={tb.y} y2={tb.y} stroke="#1e1b35" strokeDasharray="4 4" /><image href={getRankIconUrl(tb.tier, rankingConfig)} x={4} y={tb.y - 10} width="20" height="20" /><text x={28} y={tb.y + 4} fill="#6b7280" fontSize="10" textAnchor="start">{tb.tier}</text><text x={pad.left - 6} y={tb.y + 4} fill="#4b5563" fontSize="9" textAnchor="end">#{tb.rank.toLocaleString()}</text></g>))}
            {clubLines.map((c) => (<path key={`${c.id}-${latestDay}`} className="chart-line" pathLength="1" d={buildPath(c.rankSeries)} fill="none" stroke={c.clubColor} strokeWidth="2.5" opacity="0.85" />))}
            {clubLines.map((c) => { const r = c.rankSeries[latestDay]; return r != null ? <circle key={`${c.id}-d`} cx={xI(latestDay)} cy={yV(r)} r="4" fill={c.clubColor} stroke="#0a0912" strokeWidth="1.5" style={{ filter: `drop-shadow(0 0 4px ${c.clubColor})` }} /> : null; })}
            {hoverIdx != null && hoverIdx <= latestDay && (<line x1={xI(hoverIdx)} x2={xI(hoverIdx)} y1={pad.top} y2={H - pad.bottom} stroke="#7c3aed" strokeDasharray="2 4" />)}
            {hoverIdx != null && hoverIdx <= latestDay && clubLines.map((c) => { const r = c.rankSeries[hoverIdx]; return r != null ? <circle key={`${c.id}-h`} cx={xI(hoverIdx)} cy={yV(r)} r="4" fill={c.clubColor} stroke="#0a0912" strokeWidth="1" /> : null; })}
            {Array.from({ length: dim }, (_, i) => { const sx = i === 0 ? pad.left : (xI(i - 1) + xI(i)) / 2; const ex = i === dim - 1 ? W - pad.right : (xI(i) + xI(i + 1)) / 2; return <rect key={i} x={sx} y={pad.top} width={Math.max(10, ex - sx)} height={innerH} fill="transparent" onMouseEnter={() => setHoverIdx(i)} onMouseLeave={() => setHoverIdx(null)} />; })}
            {Array.from({ length: dim }, (_, i) => (i === 0 || i === dim - 1 || ((i + 1) % 5 === 0)) ? <text key={i} x={xI(i)} y={H - pad.bottom + 18} textAnchor="middle" fill={i <= latestDay ? "#6b7280" : "#312b4a"} fontSize="10">{i + 1}</text> : null)}
          </svg>
          {hoverIdx != null && hoverIdx <= latestDay && (() => { const dayNum = hoverIdx + 1; const dk = dateKeyForDay(dayNum); const items = clubLines.map((c) => ({ ...c, rank: c.rankSeries[hoverIdx] })).filter((c) => c.rank != null).sort((a, b) => a.rank - b.rank); if (!items.length) return null; const tx = Math.max(14, Math.min(86, (xI(hoverIdx) / W) * 100)); return (<div style={{ position: "absolute", left: `${tx}%`, top: 8, transform: "translateX(-50%)", background: "#111028", border: "1px solid #2a2540", borderRadius: 10, padding: "10px 12px", minWidth: 220, boxShadow: "0 16px 40px rgba(0,0,0,0.35)", pointerEvents: "none", zIndex: 5 }}><div style={{ color: "#e2e0f0", fontWeight: 700, fontSize: 12, marginBottom: 6 }}>Day {dayNum} · {dk}</div>{items.map((c) => { const tier = getTierForRank(c.rank, rankingConfig); return (<div key={c.id} style={{ display: "flex", justifyContent: "space-between", gap: 14, fontSize: 11, marginBottom: 3 }}><div style={{ display: "flex", alignItems: "center", gap: 6, color: "#e2e0f0" }}><span style={{ width: 8, height: 8, borderRadius: 999, background: c.clubColor, flexShrink: 0 }} />{c.clubName || c.name}</div><div style={{ display: "flex", alignItems: "center", gap: 4 }}>{tier && <TierIcon tier={tier} size={14} showFallbackText={false} rankingConfig={rankingConfig} rankIconPath={rankIconPath} />}<span style={{ color: "#e2e0f0", fontWeight: 700 }}>#{c.rank.toLocaleString()}</span></div></div>); })}</div>); })()}
          <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginTop: 10, color: "#9ca3af", fontSize: 11 }}>{clubLines.map((c) => (<span key={c.id} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><span style={{ width: 14, height: 3, background: c.clubColor, borderRadius: 99, display: "inline-block" }} />{c.clubName || c.name}</span>))}</div>
        </div>
      );
    }

    function RefreshCountdown({ onCycleStart = null, style = {}, className = "telemetry" }) {
      const [nowMs, setNowMs] = useState(() => Date.now());
      const notifiedCycleRef = useRef(null);

      useEffect(() => {
        const tick = setInterval(() => setNowMs(Date.now()), 1000);
        return () => clearInterval(tick);
      }, []);

      const now = new Date(nowMs);
      const meta = getRefreshScheduleMeta(now);
      const latestStarted = meta.latestStarted;

      useEffect(() => {
        if (!onCycleStart || !latestStarted) return;
        const elapsedMs = nowMs - latestStarted.date.getTime();
        if (elapsedMs < 0 || elapsedMs > SCHEDULE_AUTO_REFRESH_WINDOW_MS) return;
        if (notifiedCycleRef.current === latestStarted.key) return;
        notifiedCycleRef.current = latestStarted.key;
        onCycleStart(latestStarted);
      }, [latestStarted?.key, nowMs, onCycleStart]);

      return <span className={className} style={style}>{meta.next ? formatCountdown(meta.countdownMs) : "—"}</span>;
    }

    function getInitialRouteState() {
      const params = new URLSearchParams(window.location.search);
      const requestedClubId = PAGE_MODE === "club" ? params.get("id") : null;
      const requestedRankingsSection = params.get("section");
      const activeIndex = requestedClubId ? CURRENT_CLUBS.findIndex((club) => String(club.id) === requestedClubId) : 0;
      return {
        view: PAGE_MODE === "club" ? "club" : "home",
        archiveMonth: params.get("month") || "",
        activeIndex: activeIndex >= 0 ? activeIndex : 0,
        rankingsTab: ["clubs", "individual"].includes(requestedRankingsSection) ? requestedRankingsSection : "home",
      };
    }

    function CircleTracker() {
      const initialRouteRef = useRef(null);
      if (!initialRouteRef.current) initialRouteRef.current = getInitialRouteState();
      const initialRoute = initialRouteRef.current;
      const [view, setView] = useState(initialRoute.view);
      const [archiveMonth, setArchiveMonth] = useState(initialRoute.archiveMonth);
      const [archiveManifest, setArchiveManifest] = useState(null);
      const [activeIdx, setActiveIdx] = useState(initialRoute.activeIndex);
      const [clubsPageSelectedIdx, setClubsPageSelectedIdx] = useState(0);
      const [effectiveGameDayKey, setEffectiveGameDayKey] = useState(() => getInitialEffectiveGameDayKey(new Date()));
      const [clubData, setClubData] = useState({});
      const [loading, setLoading] = useState(false);
      const [err, setErr] = useState("");
      const [tab, setTab] = useState("dashboard");
      const [copied, setCopied] = useState(false);
      const [reminderCopied, setReminderCopied] = useState(false);
      const [debugLog, setDebugLog] = useState([]);
      const [memberSort, setMemberSort] = useState({ key: "monthlyGain", direction: "desc" });
      const [memberFilters, setMemberFilters] = useState({ name: "", status: "" });
      const [overviewStatusFilter, setOverviewStatusFilter] = useState("");
      const [paceHiddenMembers, setPaceHiddenMembers] = useState({});
      const [paceZoom, setPaceZoom] = useState(1);
      const [paceChartMode, setPaceChartMode] = useState("cumulative");
      const [networkChartMode, setNetworkChartMode] = useState("cumulative");
      const [paceExporting, setPaceExporting] = useState(false);
      const [topNetworkMode, setTopNetworkMode] = useState("daily");
      const [rankingsTab, setRankingsTab] = useState(initialRoute.rankingsTab);
      const [networkMemberVisibleCount, setNetworkMemberVisibleCount] = useState(RANKINGS_MEMBER_DEFAULT_COUNT);
      const [criticalClubFilter, setCriticalClubFilter] = useState("all");
      const [criticalSort, setCriticalSort] = useState({ key: "planDelta", direction: "asc" });
      const [criticalVisibleCount, setCriticalVisibleCount] = useState(10);
      const [pacePinnedIdx, setPacePinnedIdx] = useState(null);
      const [paceCardsCollapsed, setPaceCardsCollapsed] = useState(false);
      const [weeklyCopied, setWeeklyCopied] = useState(false);
      const [rankHistory, setRankHistory] = useState({});
      const [demotionVisibleCount, setDemotionVisibleCount] = useState(10);
      const [promotionVisibleCount, setPromotionVisibleCount] = useState(10);
      const paceSvgRef = useRef(null);
      const paceContainerRef = useRef(null);
      const scheduledRefreshCycleRef = useRef(null);
      const scheduledRefreshTimeoutsRef = useRef([]);

      const now = new Date();
      const refreshScheduleMeta = getRefreshScheduleMeta(now);
      const isArchiveView = Boolean(archiveMonth);
      const archiveMonths = Array.isArray(archiveManifest?.months) ? archiveManifest.months : [];
      const archivedFrontendConfig = isArchiveView
        ? normalizeArchiveFrontendConfig(Object.values(clubData || {}).find((entry) => entry?.archiveConfig)?.archiveConfig || null)
        : null;
      const viewClubs = getViewClubs(archivedFrontendConfig);
      const viewRankingConfig = getViewRankingConfig(archivedFrontendConfig);
      const viewClubTierOrder = getViewClubTierOrder(archivedFrontendConfig);
      const viewRankIconPath = getViewRankIconPath(archivedFrontendConfig);
      const viewTierColors = getViewTierColors(archivedFrontendConfig);
      const viewMaxMembers = Number(archivedFrontendConfig?.maxMembers || MAX_MEMBERS);
      const isDiscordExportsEnabled = true;
      const resetWindowBlocksExports = false;
      const nextRefresh = refreshScheduleMeta.next;
      const upcomingRefreshLabel = refreshScheduleMeta.upcoming.map((entry) => formatRefreshDateLabel(entry.date)).join(" · ");
      const nextRefreshDateLabel = nextRefresh ? formatRefreshDateLabel(nextRefresh.date) : "No upcoming refresh scheduled";
      const liveStatus = isArchiveView
        ? {
            label: "📦 Archive view",
            sub: `Locked Chronogenesis snapshot for ${getMonthKeyLabel(archiveMonth)}. Live auto-refresh is paused while viewing archives.`,
            color: "#c4b5fd",
            bg: "#7c3aed18",
            border: "#7c3aed55",
          }
        : {
            label: "🟢 Live from shared Chronogenesis actual_date",
            sub: "Chronogenesis uses the highest actual_date shared by all active members, and refreshes once daily at 5:15 PM UTC+7.",
            color: "#34d399",
            bg: "#34d39918",
            border: "#34d39955",
          };
      const dataDate = dateKeyToLocalDate(effectiveGameDayKey);
      const year = dataDate.getFullYear();
      const monthIndex = dataDate.getMonth();
      const today = dataDate.getDate();
      const dim = daysInMonth(year, monthIndex + 1);
      const hasComparisonData = today > 1;
      const noComparisonLabel = `No comparison data yet (Day ${today})`;
      const getDisplayStatusKey = (statusKey) => (hasComparisonData ? statusKey : DAY1_STATUS_KEY);
      const getDisplayStatusMeta = (statusKey) => STATUS_META[getDisplayStatusKey(statusKey)] || STATUS_META[DAY1_STATUS_KEY];
      const displayPlanDeltaText = (delta) => (hasComparisonData ? deltaText(delta) : "—");
      const daysLeft = dim - today;
      const monthWeeks = getMonthWeeks(year, monthIndex);

      const club = viewClubs[activeIdx] || viewClubs[0] || CURRENT_CLUBS[0];
      const cid = club.id;
      const data = cid ? (clubData[cid] || null) : null;
      const allMembers = data?.members || [];
      const activeMembers = allMembers.filter((m) => m.isActive !== false);
      const tc = viewTierColors[club.tier] || viewTierColors["B+"];
      const clubName = data?.clubName || club.name;
      const supportsMemberDailyFans = activeMembers.some((m) => (Array.isArray(m.dailyFans) && m.dailyFans.length) || (Array.isArray(m.precomputedDailyGainSeries) && m.precomputedDailyGainSeries.length));
      const displayFetch = data?.refreshedAt || data?.sourceUpdatedAt || data?.lastFetch || null;
      const displayFetchLabel = "Updated";

      function buildClubDataEntry(result) {
        return {
          members: result.members,
          clubName: result.clubName,
          lastFetch: result.lastFetch || null,
          refreshedAt: result.refreshedAt || null,
          sourceUpdatedAt: result.sourceUpdatedAt || null,
          sourceType: result.sourceType || DATA_SOURCE,
          archiveConfig: result.archiveConfig || null,
          sharedActualDate: result.sharedActualDate ?? null,
          dataYear: result.dataYear ?? null,
          dataMonth: result.dataMonth ?? null,
          datasetMonthKey: result.datasetMonthKey || null,
          archiveMonthKey: archiveMonth || null,
          clubDailyHistory: result.clubDailyHistory || [],
          clubMonthlyHistory: result.clubMonthlyHistory || [],
        };
      }

      async function fetchData(idOverride = null, silent = false) {
        const targetId = idOverride || cid;
        if (!targetId) return;
        if (!silent) { setLoading(true); setErr(""); }
        const log = [];
        const candidates = getDataCandidates(targetId, archiveMonth);
        for (const url of candidates) {
          try {
            const res = await fetch(url, { headers: { Accept: "application/json" }, cache: "no-store" });
            log.push(`${res.ok ? "✓" : "✗"} [${DATA_SOURCE}] ${url} → ${res.status}`);
            if (!res.ok) continue;
            const text = await res.text();
            const preview = parseJSON(text, null);
            if (preview.error) { log.push("  ↳ " + preview.error); continue; }
            const nextGameDayKey = resolveEffectiveGameDayKey(effectiveGameDayKey, preview, new Date());
            if (nextGameDayKey !== effectiveGameDayKey) { await loadAllData(); return; }
            const result = parseJSON(text, dateKeyToLocalDate(nextGameDayKey));
            if (result.error) { log.push("  ↳ " + result.error); continue; }
            setClubData((prev) => ({ ...prev, [targetId]: buildClubDataEntry(result) }));
            setDebugLog(log);
            if (!silent) setLoading(false);
            return;
          } catch (e) { log.push(`✗ [${DATA_SOURCE}] ${url} → ${e.message}`); }
        }
        setDebugLog(log);
        if (!silent) { setErr(`Failed to load Chronogenesis JSON for ${targetId}. Make sure the matching file exists.`); setLoading(false); }
      }

      async function loadAllData() {
        setLoading(true); setErr("");
        const allLogs = []; const rawById = {};
        let resolvedGameDayKey = effectiveGameDayKey || getInitialEffectiveGameDayKey(new Date());
        for (const c of viewClubs) {
          if (!c.id) continue;
          const candidates = getDataCandidates(c.id, archiveMonth);
          let loaded = false;
          for (const url of candidates) {
            try {
              const res = await fetch(url, { headers: { Accept: "application/json" }, cache: "no-store" });
              allLogs.push(`${res.ok ? "✓" : "✗"} [${DATA_SOURCE}] ${url} → ${res.status}`);
              if (!res.ok) continue;
              const text = await res.text();
              const preview = parseJSON(text, null);
              if (preview.error) { allLogs.push(`  ↳ ${c.id}: ${preview.error}`); continue; }
              rawById[c.id] = text;
              resolvedGameDayKey = resolveEffectiveGameDayKey(resolvedGameDayKey, preview, new Date());
              loaded = true; break;
            } catch (e) { allLogs.push(`✗ ${url} → ${e.message}`); }
          }
          if (!loaded) allLogs.push(`⚠ ${c.id} not loaded`);
        }

        const resolvedDataDate = dateKeyToLocalDate(resolvedGameDayKey);
        const next = {};

        const rankHistNext = {};
        for (const [clubId, rawText] of Object.entries(rawById)) {
            const result = parseJSON(rawText, resolvedDataDate);
            if (result.error) { allLogs.push(`  ↳ ${clubId}: ${result.error}`); continue; }
            next[clubId] = buildClubDataEntry(result);
            const history = Array.isArray(result.clubDailyHistory) ? result.clubDailyHistory : [];
            if (history.length) {
              const rankMap = {};
              history.forEach((row) => {
                const actualDate = Number(row?.actual_date);
                const rank = row?.rank == null ? null : Number(row.rank);
                if (!Number.isFinite(actualDate) || actualDate < 1 || actualDate > daysInMonth(resolvedDataDate.getFullYear(), resolvedDataDate.getMonth() + 1)) return;
                if (!Number.isFinite(rank) || rank <= 0) return;
                rankMap[formatDateKey(resolvedDataDate.getFullYear(), resolvedDataDate.getMonth() + 1, actualDate)] = {
                  rank,
                  rank_gain: Number(row?.rank_gain ?? 0),
                };
              });
              const finalMonthlyRank = getFinalClubMonthlyRank(result, resolvedDataDate.getFullYear(), resolvedDataDate.getMonth());
              const finalDayKey = formatDateKey(resolvedDataDate.getFullYear(), resolvedDataDate.getMonth() + 1, daysInMonth(resolvedDataDate.getFullYear(), resolvedDataDate.getMonth() + 1));
              if (finalMonthlyRank != null && !rankMap[finalDayKey]) {
                rankMap[finalDayKey] = { rank: finalMonthlyRank, rank_gain: null, inferredFromMonthlyHistory: true };
              }
              rankHistNext[clubId] = rankMap;
            }
        }
        setRankHistory(rankHistNext);
        setEffectiveGameDayKey(resolvedGameDayKey);
        setClubData(next); setDebugLog(allLogs); setLoading(false);
      }

      function handleScheduledRefreshCycle(latestStarted) {
        if (isArchiveView || !latestStarted) return;
        if (scheduledRefreshCycleRef.current === latestStarted.key) return;
        scheduledRefreshCycleRef.current = latestStarted.key;
        scheduledRefreshTimeoutsRef.current.forEach((timeoutId) => clearTimeout(timeoutId));
        scheduledRefreshTimeoutsRef.current = SCHEDULE_AUTO_REFRESH_RETRY_DELAYS_MS.map((delayMs) =>
          setTimeout(() => loadAllData(), delayMs)
        );
      }

      useEffect(() => { setEffectiveGameDayKey(getInitialEffectiveGameDayKey(new Date())); loadAllData(); }, [archiveMonth]);
      useEffect(() => { if (activeIdx >= viewClubs.length) setActiveIdx(0); }, [activeIdx, viewClubs.length]);
      useEffect(() => { if (clubsPageSelectedIdx >= viewClubs.length) setClubsPageSelectedIdx(0); }, [clubsPageSelectedIdx, viewClubs.length]);
      useEffect(() => {
        if (PAGE_MODE !== "clubs") return;
        const params = new URLSearchParams(window.location.search);
        if (!params.has("id")) return;
        params.delete("id");
        const query = params.toString();
        window.history.replaceState({}, "", `${window.location.pathname}${query ? `?${query}` : ""}`);
      }, []);

      useEffect(() => {
        let cancelled = false;
        const loadArchiveManifest = async () => {
          for (const url of ["./data/chronogenesis/archive/manifest.json", "/data/chronogenesis/archive/manifest.json"]) {
            try {
              const res = await fetch(url, { headers: { Accept: "application/json" }, cache: "no-store" });
              if (!res.ok) continue;
              const json = await res.json();
              if (!cancelled) setArchiveManifest(json);
              return;
            } catch (e) {}
          }
          if (!cancelled) setArchiveManifest({ months: [], clubs: {}, files: [] });
        };
        loadArchiveManifest();
        return () => { cancelled = true; };
      }, []);

      useEffect(() => {
        return () => {
          scheduledRefreshTimeoutsRef.current.forEach((timeoutId) => clearTimeout(timeoutId));
          scheduledRefreshTimeoutsRef.current = [];
        };
      }, [archiveMonth]);

      useEffect(() => {
        if (isArchiveView) return;
        safeWriteStoredGameDayKey(effectiveGameDayKey);
      }, [effectiveGameDayKey, archiveMonth]);

      useEffect(() => { if (cid && !clubData[cid]) fetchData(cid, true); }, [activeIdx, archiveMonth]);
      useEffect(() => { setCriticalVisibleCount(10); }, [criticalClubFilter, criticalSort]);
      useEffect(() => { setNetworkMemberVisibleCount(RANKINGS_MEMBER_DEFAULT_COUNT); }, [topNetworkMode]);
      useEffect(() => { setPaceHiddenMembers({}); setOverviewStatusFilter(""); setPaceZoom(1); setPacePinnedIdx(null); }, [cid]);
      useEffect(() => { if (!hasComparisonData) { setOverviewStatusFilter(""); setMemberFilters((prev) => (prev.status ? { ...prev, status: "" } : prev)); } }, [hasComparisonData, cid]);

      function decorateMember(member, monthlyTarget) {
        const rawCumulativeSeries = Array.isArray(member.precomputedCumulativeSeries) && member.precomputedCumulativeSeries.length
          ? member.precomputedCumulativeSeries
          : buildCumulativeSeries(member.dailyFans, dim);
        const normalizedSeries = (Array.isArray(member.precomputedCumulativeSeries) && member.precomputedCumulativeSeries.length)
          ? { cumulativeSeries: rawCumulativeSeries, dailyGainSeries: Array.isArray(member.precomputedDailyGainSeries) && member.precomputedDailyGainSeries.length ? member.precomputedDailyGainSeries : buildDailyGainSeries(rawCumulativeSeries) }
          : normalizeMemberSeries(rawCumulativeSeries, member, dim, today - 1);
        const cumulativeSeries = normalizedSeries.cumulativeSeries;
        const dailyGainSeries = normalizedSeries.dailyGainSeries;
        const effectiveMonthlyGain = member.monthlyGain ?? (cumulativeSeries[today - 1] ?? cumulativeSeries.reduce((last, value) => value > 0 ? value : last, 0));
        const effectiveDailyGain = member.dailyGain ?? (() => { for (let i = Math.min(today - 1, dailyGainSeries.length - 1); i >= 0; i--) if ((dailyGainSeries[i] ?? 0) > 0) return dailyGainSeries[i]; return null; })();
        const effectiveProjected = member.projected ?? (() => { const daysWithData = cumulativeSeries.reduce((count, value) => count + (value > 0 ? 1 : 0), 0); return daysWithData > 0 ? Math.round((effectiveMonthlyGain / Math.max(daysWithData, 1)) * dim) : null; })();
        const normalizedMember = { ...member, monthlyGain: effectiveMonthlyGain, dailyGain: effectiveDailyGain, projected: effectiveProjected };
        const plan = getPlanMetrics(effectiveMonthlyGain ?? 0, monthlyTarget, today, dim, monthWeeks);
        const rolling3DayAvg = getTrailingAverage(dailyGainSeries, today - 1, 3);
        const fansNeededForPlan = Math.max(0, monthlyTarget - (effectiveMonthlyGain ?? 0));
        const stagnantDays = getStagnantDays(dailyGainSeries, today - 1);
        const daysToTarget = rolling3DayAvg > 0 ? Math.ceil(fansNeededForPlan / rolling3DayAvg) : Infinity;
        return { ...normalizedMember, rawCumulativeSeries, cumulativeSeries, dailyGainSeries, rolling3DayAvg, fansNeededForPlan, plan, stagnantDays, daysToTarget };
      }

      const decoratedMembers = activeMembers.map((member) => decorateMember(member, club.target));
      const activeClubDailyMetrics = buildClubDailyMetrics(data, decoratedMembers, dim, today);
      const totalFans = decoratedMembers.reduce((sum, member) => sum + (member.fans || 0), 0);
      const totalDaily = activeClubDailyMetrics.totalDaily ?? decoratedMembers.reduce((sum, member) => sum + (member.dailyGain ?? 0), 0);
      const totalPreviousDaily = activeClubDailyMetrics.previousDaily;
      const clubDailyTrendDelta = activeClubDailyMetrics.dailyTrendDelta;
      const totalMonthly = decoratedMembers.reduce((sum, member) => sum + (member.monthlyGain ?? 0), 0);
      const totalProj = decoratedMembers.reduce((sum, member) => sum + (member.projected ?? 0), 0);
      const clubMonthlyTarget = decoratedMembers.length * club.target;
      const clubExpectedToDate = Math.round((clubMonthlyTarget / Math.max(dim, 1)) * today);
      const clubWeeklyDelta = totalMonthly - clubExpectedToDate;

      const statusCounts = hasComparisonData ? decoratedMembers.reduce((acc, member) => { acc[member.plan.statusKey] += 1; return acc; }, { "on-track": 0, "behind": 0, "critical": 0 }) : { "on-track": 0, "behind": 0, "critical": 0 };
      const membersOnTrack = statusCounts["on-track"];
      const sortedByMonthly = [...decoratedMembers].sort((a, b) => (b.monthlyGain ?? 0) - (a.monthlyGain ?? 0));
      const overviewMembers = overviewStatusFilter ? sortedByMonthly.filter((member) => member.plan.statusKey === overviewStatusFilter) : sortedByMonthly;

      const perMemberDailyTarget = Math.round(club.target / Math.max(dim, 1));
      const individualDailyTargetSeries = Array.from({ length: dim }, () => perMemberDailyTarget);
      const individualCumulativeTargetSeries = Array.from({ length: dim }, (_, index) => perMemberDailyTarget * (index + 1));
      const allPaceSeriesList = decoratedMembers.map((member, index) => ({ name: member.name, statusKey: member.plan.statusKey, color: getLineColor(index), dailySeries: member.dailyGainSeries, cumulativeSeries: member.cumulativeSeries, series: paceChartMode === "daily" ? member.dailyGainSeries : member.cumulativeSeries }));
      const paceSeriesList = allPaceSeriesList.filter((item) => !paceHiddenMembers[item.name]);
      const selectedPaceTargetSeries = paceChartMode === "daily" ? individualDailyTargetSeries : individualCumulativeTargetSeries;

      // Helper to get rank info for a club
      function getClubRankInfo(clubId) {
        const h = rankHistory[clubId];
        if (!h) return { rank: null, delta: null };
        const cur = h[effectiveGameDayKey]?.rank ?? null;
        const prevKey = getPreviousDisplayKeyFromKey(effectiveGameDayKey);
        const prev = h[prevKey]?.rank ?? null;
        const delta = (cur != null && prev != null) ? prev - cur : null;
        return { rank: cur, delta };
      }

      const networkClubs = viewClubs.map((entry) => {
        const cdata = entry.id ? clubData[entry.id] : null;
        const cMembers = (cdata?.members || []).filter((member) => member.isActive !== false);
        const decorated = cMembers.map((member) => decorateMember(member, entry.target));
        const clubStatusCounts = decorated.reduce((acc, member) => { acc[member.plan.statusKey] += 1; return acc; }, { "on-track": 0, "behind": 0, "critical": 0 });
        const totalM = decorated.reduce((sum, member) => sum + (member.monthlyGain ?? 0), 0);
        const totalP = decorated.reduce((sum, member) => sum + (member.projected ?? 0), 0);
        const clubTarget = decorated.length * entry.target;
        const nonStagnant = decorated.filter((m) => m.stagnantDays < 3).length;
        const pctOnTrack = decorated.length > 0 ? clubStatusCounts["on-track"] / decorated.length : 0;
        const projectedRatio = clubTarget > 0 ? totalP / clubTarget : 0;
        const nonStagnantRatio = decorated.length > 0 ? nonStagnant / decorated.length : 0;
        const health = computeHealthGrade(pctOnTrack, projectedRatio, nonStagnantRatio);
        const clubDailyMetrics = buildClubDailyMetrics(cdata, decorated, dim, today);
        const historyDailySeries = clubDailyMetrics.historyDailySeries;
        const clubDailySeries = clubDailyMetrics.clubDailySeries;
        const totalDaily = clubDailyMetrics.totalDaily;
        const previousDaily = clubDailyMetrics.previousDaily;
        const dailyTrendDelta = clubDailyMetrics.dailyTrendDelta;
        const clubCumSeries = historyDailySeries
          ? (() => {
              const absoluteFanCountSeries = new Array(dim).fill(null);
              cdata.clubDailyHistory.forEach((row) => {
                const actualDate = Number(row?.actual_date);
                if (!Number.isFinite(actualDate) || actualDate < 1 || actualDate > dim) return;
                const fanCount = Number(row?.interpolated_fan_count);
                if (Number.isFinite(fanCount) && fanCount > 0) absoluteFanCountSeries[actualDate - 1] = fanCount;
              });

              // Archive snapshots can have complete member data but miss the final club_daily_history row.
              // Missing days should not be graphed as zero; carry forward the last known club count and
              // use club_monthly_history.monthly_fan_gain as the month-end total when available.
              const monthlyHistoryFinalGain = getFinalClubMonthlyFanGain(cdata, year, monthIndex);
              const memberComputedFinalGain = decorated.reduce((sum, member) => sum + (member.monthlyGain ?? 0), 0);
              const baseline = absoluteFanCountSeries.find((value) => value != null && value > 0) || 0;
              let lastFanCount = null;
              const cumulative = absoluteFanCountSeries.map((value) => {
                if (value != null && value > 0) lastFanCount = value;
                if (lastFanCount == null || baseline <= 0) return null;
                return Math.max(0, lastFanCount - baseline);
              });

              // Some archived snapshots can contain a complete day-30 rank row while the
              // archived club_monthly_history/monthly_fan_gain is stale or lower than the
              // day-29 cumulative count. Never let the cumulative pace line move backward;
              // use the strongest month-end total we can verify from club history or members.
              const finalGainCandidates = [monthlyHistoryFinalGain, memberComputedFinalGain, cumulative[dim - 1]]
                .map((value) => Number(value))
                .filter((value) => Number.isFinite(value) && value >= 0);
              const bestFinalGain = finalGainCandidates.length ? Math.max(...finalGainCandidates) : null;
              if (bestFinalGain != null) cumulative[dim - 1] = Math.max(bestFinalGain, cumulative[dim - 2] ?? 0);

              for (let i = 1; i < cumulative.length; i++) {
                if (cumulative[i] == null && cumulative[i - 1] != null) cumulative[i] = cumulative[i - 1];
                if (cumulative[i] != null && cumulative[i - 1] != null && cumulative[i] < cumulative[i - 1]) cumulative[i] = cumulative[i - 1];
              }
              return cumulative.map((value) => value ?? 0);
            })()
          : buildCumulativeFromDailyGainSeries(clubDailySeries, dim);
        const clubPctSeries = clubTarget > 0 ? clubCumSeries.map((v) => (v / clubTarget) * 100) : [];
        const clubDailyPctSeries = clubTarget > 0 ? clubDailySeries.map((v) => (v / clubTarget) * 100) : [];
        const ri = getClubRankInfo(entry.id);
        return {
          ...entry, clubName: cdata?.clubName || entry.name, activeMembers: decorated.length,
          totalFans: decorated.reduce((sum, member) => sum + (member.fans || 0), 0),
          totalMonthly: totalM, totalDaily, previousDaily, dailyTrendDelta, totalProjected: totalP,
          totalExpected: Math.round((decorated.length * entry.target / Math.max(dim, 1)) * today),
          hasData: Boolean(cdata), lastFetch: cdata?.lastFetch || null, refreshedAt: cdata?.refreshedAt || null,
          sourceUpdatedAt: cdata?.sourceUpdatedAt || null, jsonMeta: getJsonLoadMeta(entry, cdata, now),
          statusCounts: clubStatusCounts,
          topFiveMembers: [...decorated].sort((a, b) => (b.monthlyGain ?? 0) - (a.monthlyGain ?? 0)).slice(0, 5),
          health, pctOnTrack, projectedRatio, nonStagnantRatio, nonStagnantMembers: nonStagnant, clubTarget,
          clubDailySeries, clubCumSeries, clubPctSeries, clubDailyPctSeries, clubColor: getClubColor(viewClubs.indexOf(entry)),
          currentMonthlyRank: ri.rank, rankDelta: ri.delta,
        };
      });

      const networkMembers = networkClubs.filter((entry) => entry.id && clubData[entry.id]).flatMap((entry) => {
        const members = (clubData[entry.id]?.members || []).filter((member) => member.isActive !== false).map((member) => ({ ...decorateMember(member, entry.target), clubName: clubData[entry.id]?.clubName || entry.name, clubTier: entry.tier, clubTarget: entry.target }));
        return members;
      }).sort((a, b) => { const monthDiff = (b.monthlyGain ?? Number.NEGATIVE_INFINITY) - (a.monthlyGain ?? Number.NEGATIVE_INFINITY); if (monthDiff !== 0) return monthDiff; const projectedDiff = (b.projected ?? Number.NEGATIVE_INFINITY) - (a.projected ?? Number.NEGATIVE_INFINITY); if (projectedDiff !== 0) return projectedDiff; return (a.name || "").localeCompare(b.name || ""); });

      const topNetworkUsers = hasComparisonData ? [...networkMembers].sort((a, b) => { if (topNetworkMode === "monthly") { const monthDiff = (b.monthlyGain ?? Number.NEGATIVE_INFINITY) - (a.monthlyGain ?? Number.NEGATIVE_INFINITY); if (monthDiff !== 0) return monthDiff; const dayDiff = (b.dailyGain ?? Number.NEGATIVE_INFINITY) - (a.dailyGain ?? Number.NEGATIVE_INFINITY); if (dayDiff !== 0) return dayDiff; } else { const dayDiff = (b.dailyGain ?? Number.NEGATIVE_INFINITY) - (a.dailyGain ?? Number.NEGATIVE_INFINITY); if (dayDiff !== 0) return dayDiff; const monthDiff = (b.monthlyGain ?? Number.NEGATIVE_INFINITY) - (a.monthlyGain ?? Number.NEGATIVE_INFINITY); if (monthDiff !== 0) return monthDiff; } return (a.name || "").localeCompare(b.name || ""); }) : [];
      const visibleNetworkUsers = topNetworkUsers.slice(0, networkMemberVisibleCount);
      const remainingNetworkUserCount = Math.max(0, topNetworkUsers.length - visibleNetworkUsers.length);
      const hiddenOnNetworkResetCount = Math.max(0, topNetworkUsers.length - RANKINGS_MEMBER_DEFAULT_COUNT);
      const rankedNetworkClubs = [...networkClubs]
        .filter((entry) => entry.id && entry.hasData)
        .sort((a, b) => {
          if (a.currentMonthlyRank == null && b.currentMonthlyRank == null) return a.clubName.localeCompare(b.clubName);
          if (a.currentMonthlyRank == null) return 1;
          if (b.currentMonthlyRank == null) return -1;
          return a.currentMonthlyRank - b.currentMonthlyRank;
        });
      const loadedClubCount = networkClubs.filter((entry) => entry.hasData).length;
      const networkMonthlyTotal = networkMembers.reduce((sum, member) => sum + (member.monthlyGain ?? 0), 0);
      const networkFanTotal = networkMembers.reduce((sum, member) => sum + (member.fans || 0), 0);
      const networkMemberCount = networkMembers.length;
      const clubsMissingData = networkClubs.filter((entry) => entry.id && !entry.hasData).length;
      const networkStatusCounts = hasComparisonData ? networkMembers.reduce((acc, member) => { acc[member.plan.statusKey] += 1; return acc; }, { "on-track": 0, "behind": 0, "critical": 0 }) : { "on-track": 0, "behind": 0, "critical": 0 };
      const networkMembersAtOrAbovePlan = hasComparisonData ? networkStatusCounts["on-track"] : 0;
      const criticalClubOptions = hasComparisonData ? Array.from(new Set(networkMembers.filter((member) => member.plan.statusKey === "critical").map((member) => member.clubName))).sort((a, b) => a.localeCompare(b)) : [];
      const criticalAvgColor = (value) => value <= 0 ? "#f87171" : value < 200000 ? "#fbbf24" : "#34d399";
      const criticalBaseMembers = hasComparisonData ? [...networkMembers].filter((member) => member.plan.statusKey === "critical").filter((member) => criticalClubFilter === "all" || member.clubName === criticalClubFilter) : [];
      const criticalNetworkMembers = criticalSort.key && criticalSort.direction !== "off" ? [...criticalBaseMembers].sort((a, b) => { const getValue = (member) => { switch (criticalSort.key) { case "projected": return member.projected ?? Number.NEGATIVE_INFINITY; case "rolling3DayAvg": return member.rolling3DayAvg ?? Number.NEGATIVE_INFINITY; case "fansNeeded": return member.fansNeededForPlan ?? Number.NEGATIVE_INFINITY; case "planDelta": default: return member.plan.delta ?? Number.NEGATIVE_INFINITY; } }; const av = getValue(a); const bv = getValue(b); if (av === bv) return (a.name || "").localeCompare(b.name || ""); return criticalSort.direction === "asc" ? av - bv : bv - av; }) : criticalBaseMembers;
      const visibleCriticalMembers = criticalNetworkMembers.slice(0, criticalVisibleCount);
      const remainingCriticalCount = Math.max(0, criticalNetworkMembers.length - visibleCriticalMembers.length);

      const transferCandidates = (() => {
        if (!hasComparisonData) return { demotionCandidates: [], promotionCandidates: [] };
        const demotionCandidates = networkMembers
          .filter((m) => m.plan.statusKey === "critical" || (m.plan.statusKey === "behind" && m.stagnantDays >= 3))
          .map((m) => ({ ...m, projectedTier: getSuggestedTierForProjectedMonthly(m.projected ?? 0, viewClubs), expectedClubTier: getExpectedClubTier(m.clubTier, m.projected ?? 0, "demotion", viewClubs, viewClubTierOrder) }))
          .sort((a, b) => (a.plan.delta ?? 0) - (b.plan.delta ?? 0))
          .slice(0, 15);
        const promotionCandidates = networkMembers
          .filter((m) => m.clubTier !== "S+" && m.plan.statusKey === "on-track" && (m.monthlyGain ?? 0) > m.clubTarget * 1.2)
          .map((m) => ({ ...m, projectedTier: getSuggestedTierForProjectedMonthly(m.projected ?? 0, viewClubs), expectedClubTier: getExpectedClubTier(m.clubTier, m.projected ?? 0, "promotion", viewClubs, viewClubTierOrder) }))
          .sort((a, b) => (b.monthlyGain ?? 0) - (a.monthlyGain ?? 0))
          .slice(0, 15);
        return { demotionCandidates, promotionCandidates };
      })();

      function toggleCriticalSort(key) { setCriticalSort((prev) => { if (prev.key !== key || prev.direction === "off") return { key, direction: "desc" }; if (prev.direction === "desc") return { key, direction: "asc" }; return { key: null, direction: "off" }; }); }
      function criticalSortLabel(key) { if (criticalSort.key !== key || criticalSort.direction === "off") return "OFF"; return criticalSort.direction === "asc" ? "ASC" : "DESC"; }

      function getSourceLabel() {
        return "Chronogenesis";
      }

      function getDiscordPingLabel() {
        return club.tag || `@${club.name}`;
      }

      function getDiscordExportData() {
        function charDisplayWidth(char) {
          if (!char) return 0;
          const code = char.codePointAt(0);
          if (code == null) return 0;
          if (
            (code >= 0x1100 && code <= 0x115F) ||
            (code >= 0x2329 && code <= 0x232A) ||
            (code >= 0x2E80 && code <= 0xA4CF) ||
            (code >= 0xAC00 && code <= 0xD7A3) ||
            (code >= 0xF900 && code <= 0xFAFF) ||
            (code >= 0xFE10 && code <= 0xFE19) ||
            (code >= 0xFE30 && code <= 0xFE6F) ||
            (code >= 0xFF00 && code <= 0xFF60) ||
            (code >= 0xFFE0 && code <= 0xFFE6) ||
            (code >= 0x1F300 && code <= 0x1FAFF)
          ) return 2;
          return 1;
        }
        function getDisplayWidth(value) {
          return Array.from(String(value ?? "")).reduce((sum, ch) => sum + charDisplayWidth(ch), 0);
        }
        function truncateDisplayWidth(value, maxWidth) {
          const chars = Array.from(String(value ?? ""));
          let out = "";
          let width = 0;
          for (const ch of chars) {
            const nextWidth = width + charDisplayWidth(ch);
            if (nextWidth > maxWidth) break;
            out += ch;
            width = nextWidth;
          }
          return out;
        }
        function padEndDisplay(value, width) {
          const truncated = truncateDisplayWidth(value, width);
          const pad = Math.max(0, width - getDisplayWidth(truncated));
          return truncated + " ".repeat(pad);
        }
        function padStartDisplay(value, width) {
          const stringValue = String(value ?? "");
          const pad = Math.max(0, width - getDisplayWidth(stringValue));
          return " ".repeat(pad) + stringValue;
        }

        const ANSI_RESET = "\u001b[0m";
        const ANSI_GREEN = "\u001b[0;32m";
        const ANSI_YELLOW = "\u001b[0;33m";
        const ANSI_RED = "\u001b[0;31m";
        const ANSI_WHITE = "\u001b[0;37m";

        function getStatusAnsi(statusKey) {
          const displayStatusKey = getDisplayStatusKey(statusKey);
          if (displayStatusKey === "on-track") return ANSI_GREEN;
          if (displayStatusKey === "critical") return ANSI_RED;
          if (displayStatusKey === DAY1_STATUS_KEY) return ANSI_WHITE;
          return ANSI_YELLOW;
        }

        function getStatusColor(statusKey) {
          const displayStatusKey = getDisplayStatusKey(statusKey);
          if (displayStatusKey === "on-track") return "#84cc16";
          if (displayStatusKey === "critical") return "#ef4444";
          if (displayStatusKey === DAY1_STATUS_KEY) return "#e5e7eb";
          return "#fbbf24";
        }

        function colorizeCell(text, statusKey) {
          return `${getStatusAnsi(statusKey)}${text}${ANSI_RESET}`;
        }

        const PL = padEndDisplay;
        const P = padStartDisplay;
        const SEP = " | ";
        const ds = dataDate.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
        const sortedMembers = [...decoratedMembers].sort((a, b) => (b.monthlyGain ?? 0) - (a.monthlyGain ?? 0));

        const memberLabels = sortedMembers.map((member) => `${member.name}`);
        const dailyLabels = sortedMembers.map((member) => fmtSigned(member.dailyGain ?? 0));
        const monthLabels = sortedMembers.map((member) => {
          const paceText = hasComparisonData ? fmtSigned(member.plan.delta ?? 0) : "—";
          return `${fmtSigned(member.monthlyGain ?? 0)} (${paceText})`;
        });

        const totalDailyLabel = fmtSigned(totalDaily);
        const totalMonthLabel = `${fmtSigned(totalMonthly)} (${hasComparisonData ? fmtSigned(clubWeeklyDelta) : "—"})`;

        const COL_MEMBER = Math.max(
          getDisplayWidth("MEMBER"),
          getDisplayWidth("TOTAL"),
          ...memberLabels.map(getDisplayWidth)
        ) + 4;
        const COL_DAILY = Math.max(
          getDisplayWidth("DAILY"),
          getDisplayWidth(totalDailyLabel),
          ...dailyLabels.map(getDisplayWidth)
        );
        const COL_MONTH = Math.max(
          getDisplayWidth("MONTH (VS. PACE)"),
          getDisplayWidth(totalMonthLabel),
          ...monthLabels.map(getDisplayWidth)
        );
        const TABLE_WIDTH = COL_MEMBER + SEP.length + COL_DAILY + SEP.length + COL_MONTH;

        const topLines = [
          `📊 **[${club.tier}] ${club.name} — Circle Report** | ${ds}`,
          `${getDiscordPingLabel()}`,
          `🗂️ Source: ${getSourceLabel()}`,
          `🎯 Target: ${fmt(club.target)}/member · 👥 ${decoratedMembers.length}/${viewMaxMembers} active · 📅 Day ${today}/${dim}`,
          `📈 Club Month: ${fmtSigned(totalMonthly)}`,
          `${clubWeeklyDelta >= 0 ? "🟢 Ahead of pace" : "🔴 Behind pace"}: ${fmtSigned(clubWeeklyDelta)}`,
          `🟢 On Track: ${statusCounts["on-track"]} · 🟡 Behind: ${statusCounts["behind"]} · 🔴 Critical: ${statusCounts["critical"]}`
        ];

        const tableHeader = `${PL("MEMBER", COL_MEMBER)}${SEP}${P("DAILY", COL_DAILY)}${SEP}${P("MONTH (VS. PACE)", COL_MONTH)}`;
        const divider = "─".repeat(TABLE_WIDTH);

        const tableRows = sortedMembers.map((member) => {
          const paceText = hasComparisonData ? fmtSigned(member.plan.delta ?? 0) : "—";
          const memberText = PL(`${member.name}`, COL_MEMBER);
          const dailyText = P(fmtSigned(member.dailyGain ?? 0), COL_DAILY);
          const monthText = P(`${fmtSigned(member.monthlyGain ?? 0)} (${paceText})`, COL_MONTH);
          return {
            memberText,
            dailyText,
            monthText,
            statusKey: member.plan.statusKey,
            ansi: `${colorizeCell(memberText, member.plan.statusKey)}${SEP}${dailyText}${SEP}${monthText}`,
            pngLine: `${memberText}${SEP}${dailyText}${SEP}${monthText}`,
            nameColor: getStatusColor(member.plan.statusKey)
          };
        });

        const totalLine = `${PL("TOTAL", COL_MEMBER)}${SEP}${P(totalDailyLabel, COL_DAILY)}${SEP}${P(totalMonthLabel, COL_MONTH)}`;
        const footerLine = `> 🤖 *Dominator Network Tracker · ${getDiscordPingLabel()}*`;

        const fullMessage = [...topLines, "```ansi", tableHeader, divider, ...tableRows.map((row) => row.ansi), divider, totalLine, "```", footerLine].join("\n");
        const textOnlyMessage = [...topLines, "", footerLine].join("\n");

        const pngTopLines = topLines
          .filter((line) => line !== getDiscordPingLabel())
          .map((line) => line.replace(/\*\*/g, ""));

        return {
          topLines,
          pngTopLines,
          tableHeader,
          divider,
          tableRows,
          totalLine,
          footerLine,
          textOnlyMessage,
          fullMessage
        };
      }

      function buildDiscord() {
        return getDiscordExportData().fullMessage;
      }

      async function renderDiscordTablePng(scale = 2) {
        const exportData = getDiscordExportData();
        const lines = [...exportData.pngTopLines, "", exportData.tableHeader, exportData.divider, ...exportData.tableRows.map((row) => row.pngLine), exportData.divider, exportData.totalLine];
        if (!lines.length) return null;

        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d");
        if (!ctx) return null;

        const fontSize = 22;
        const lineHeight = 34;
        const paddingX = 24;
        const paddingY = 22;
        const borderRadius = 16;
        const font = `${fontSize}px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace`;

        ctx.font = font;
        const measuredWidth = Math.max(...lines.map((line) => ctx.measureText(line).width));
        const width = Math.ceil((paddingX * 2 + measuredWidth) * scale);
        const height = Math.ceil((paddingY * 2 + (lines.length * lineHeight)) * scale);

        canvas.width = width;
        canvas.height = height;

        ctx.scale(scale, scale);
        ctx.font = font;
        ctx.textBaseline = "top";

        const drawRoundedRect = (x, y, w, h, r) => {
          ctx.beginPath();
          ctx.moveTo(x + r, y);
          ctx.lineTo(x + w - r, y);
          ctx.quadraticCurveTo(x + w, y, x + w, y + r);
          ctx.lineTo(x + w, y + h - r);
          ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
          ctx.lineTo(x + r, y + h);
          ctx.quadraticCurveTo(x, y + h, x, y + h - r);
          ctx.lineTo(x, y + r);
          ctx.quadraticCurveTo(x, y, x + r, y);
          ctx.closePath();
        };

        drawRoundedRect(0, 0, width / scale, height / scale, borderRadius);
        ctx.fillStyle = "#111028";
        ctx.fill();

        ctx.strokeStyle = "#2a2540";
        ctx.lineWidth = 1;
        drawRoundedRect(0.5, 0.5, width / scale - 1, height / scale - 1, borderRadius);
        ctx.stroke();

        const x = paddingX;
        let y = paddingY;

        ctx.fillStyle = "#e5e7eb";
        exportData.pngTopLines.forEach((line) => {
          ctx.fillText(line, x, y);
          y += lineHeight;
        });

        y += lineHeight * 0.5;

        ctx.fillStyle = "#e5e7eb";
        ctx.fillText(exportData.tableHeader, x, y);
        y += lineHeight;

        ctx.fillStyle = "#d1d5db";
        ctx.fillText(exportData.divider, x, y);
        y += lineHeight;

        exportData.tableRows.forEach((row) => {
          ctx.fillStyle = row.nameColor;
          ctx.fillText(row.memberText, x, y);

          const memberWidth = ctx.measureText(row.memberText).width;
          ctx.fillStyle = "#e5e7eb";
          ctx.fillText(` | ${row.dailyText} | ${row.monthText}`, x + memberWidth, y);
          y += lineHeight;
        });

        ctx.fillStyle = "#d1d5db";
        ctx.fillText(exportData.divider, x, y);
        y += lineHeight;

        ctx.fillStyle = "#e5e7eb";
        ctx.fillText(exportData.totalLine, x, y);

        return await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
      }

      async function renderDiscordMessagePng(message, scale = 2) {
        if (!message) return null;
        const rawLines = String(message).split("\n");

        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d");
        if (!ctx) return null;

        const fontSize = 22;
        const lineHeight = 34;
        const paddingX = 24;
        const paddingY = 22;
        const borderRadius = 16;
        const maxWidth = 1080;
        const maxTextWidth = maxWidth - (paddingX * 2);
        const font = `${fontSize}px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace`;

        ctx.font = font;
        const wrappedLines = [];
        rawLines.forEach((rawLine) => {
          if (!rawLine) {
            wrappedLines.push("");
            return;
          }
          let current = "";
          rawLine.split(" ").forEach((word) => {
            const candidate = current ? `${current} ${word}` : word;
            if (!current || ctx.measureText(candidate).width <= maxTextWidth) {
              current = candidate;
            } else {
              wrappedLines.push(current);
              current = word;
            }
          });
          wrappedLines.push(current);
        });

        const measuredWidth = Math.max(...wrappedLines.map((line) => ctx.measureText(line || " ").width), 0);
        const width = Math.ceil((paddingX * 2 + measuredWidth) * scale);
        const height = Math.ceil((paddingY * 2 + (wrappedLines.length * lineHeight)) * scale);

        canvas.width = width;
        canvas.height = height;

        ctx.scale(scale, scale);
        ctx.font = font;
        ctx.textBaseline = "top";

        const drawRoundedRect = (x, y, w, h, r) => {
          ctx.beginPath();
          ctx.moveTo(x + r, y);
          ctx.lineTo(x + w - r, y);
          ctx.quadraticCurveTo(x + w, y, x + w, y + r);
          ctx.lineTo(x + w, y + h - r);
          ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
          ctx.lineTo(x + r, y + h);
          ctx.quadraticCurveTo(x, y + h, x, y + h - r);
          ctx.lineTo(x, y + r);
          ctx.quadraticCurveTo(x, y, x + r, y);
          ctx.closePath();
        };

        drawRoundedRect(0, 0, width / scale, height / scale, borderRadius);
        ctx.fillStyle = "#111028";
        ctx.fill();

        ctx.strokeStyle = "#2a2540";
        ctx.lineWidth = 1;
        drawRoundedRect(0.5, 0.5, width / scale - 1, height / scale - 1, borderRadius);
        ctx.stroke();

        const x = paddingX;
        let y = paddingY;

        wrappedLines.forEach((line) => {
          if (line.startsWith("❗")) ctx.fillStyle = "#f87171";
          else if (line.startsWith("⚠️")) ctx.fillStyle = "#fbbf24";
          else if (line.startsWith("✅")) ctx.fillStyle = "#34d399";
          else if (line.startsWith("> ")) ctx.fillStyle = "#9ca3af";
          else ctx.fillStyle = "#e5e7eb";
          ctx.fillText(line, x, y);
          y += lineHeight;
        });

        return await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
      }

      async function exportDiscordPayload(exportData, filename = "circle-report.png", pngRenderer = () => renderDiscordTablePng(2)) {
        if (!isDiscordExportsEnabled) return false;
        let result = "text";
        const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

        try {
          const pngBlob = await pngRenderer();

          if (isIOS && pngBlob && navigator.share) {
            const file = new File([pngBlob], filename, { type: "image/png" });
            const shareData = { files: [file] };
            if (!navigator.canShare || navigator.canShare(shareData)) {
              await navigator.share(shareData);
              result = "shared";
            } else if (navigator.clipboard?.writeText) {
              await navigator.clipboard.writeText(exportData.fullMessage);
              result = "text";
            }
          } else if (pngBlob && window.ClipboardItem && navigator.clipboard?.write) {
            await navigator.clipboard.write([
              new ClipboardItem({
                "text/plain": new Blob([exportData.textOnlyMessage], { type: "text/plain" }),
                "image/png": pngBlob
              })
            ]);
            result = "image";
          } else if (pngBlob && navigator.share) {
            const file = new File([pngBlob], filename, { type: "image/png" });
            const shareData = { text: exportData.textOnlyMessage, files: [file] };
            if (!navigator.canShare || navigator.canShare(shareData)) {
              await navigator.share(shareData);
              result = "shared";
            } else if (navigator.clipboard?.writeText) {
              await navigator.clipboard.writeText(exportData.fullMessage);
              result = "text";
            }
          } else if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(exportData.fullMessage);
            result = "text";
          }
        } catch (error) {
          try {
            const pngBlob = await pngRenderer();
            if (pngBlob && navigator.share) {
              const file = new File([pngBlob], filename, { type: "image/png" });
              const shareData = isIOS ? { files: [file] } : { text: exportData.textOnlyMessage, files: [file] };
              if (!navigator.canShare || navigator.canShare(shareData)) {
                await navigator.share(shareData);
                result = "shared";
              } else if (navigator.clipboard?.writeText) {
                await navigator.clipboard.writeText(exportData.fullMessage);
                result = "text";
              }
            } else if (navigator.clipboard?.writeText) {
              await navigator.clipboard.writeText(exportData.fullMessage);
              result = "text";
            }
          } catch (fallbackError) {
            if (navigator.clipboard?.writeText) {
              await navigator.clipboard.writeText(exportData.fullMessage);
            }
            result = "text";
          }
        }
        return result;
      }

      async function copyDiscord() {
        const exportData = getDiscordExportData();
        const result = await exportDiscordPayload(exportData, "circle-report.png", () => renderDiscordTablePng(2));
        if (!result) return;
        setCopied(result);
        setTimeout(() => setCopied(false), 2200);
      }

      function buildReminderDiscord() {
        const ds = dataDate.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
        const underPlanMembers = [...decoratedMembers].filter((member) => member.plan.statusKey !== "on-track").sort((a, b) => (a.plan.delta ?? 0) - (b.plan.delta ?? 0));
        const lines = [`🔔 **[${club.tier}] ${club.name} — Under Plan Reminder** | ${ds}`, `🗂️ Source: ${getSourceLabel()}`, `Members still under plan this week. Push for pace before ${getWeekLabel(currentWeek, year, monthIndex)} ends.`, ""];
        if (!underPlanMembers.length) { lines.push("✅ Everyone is currently on track."); return lines.join("\n"); }
        underPlanMembers.forEach((member) => { const meta = STATUS_META[member.plan.statusKey] || STATUS_META["behind"]; lines.push(`${meta.icon} **${member.name}** — ${deltaText(member.plan.delta)} vs plan · ${fmt(member.fansNeededForPlan)} still needed this month`); });
        const footer = `\n> 🤖 *Dominator Network Tracker · ${getDiscordPingLabel()}*`; let message = lines.join("\n") + footer;
        if (message.length > 3900) { const trimmed = []; for (const line of lines) { const candidate = [...trimmed, line].join("\n") + footer; if (candidate.length > 3900) break; trimmed.push(line); } const omitted = Math.max(0, underPlanMembers.length - Math.max(0, trimmed.length - 3)); if (omitted > 0) trimmed.push(`… ${omitted} more members omitted to stay under Discord limit`); message = trimmed.join("\n") + footer; }
        return message;
      }

      function buildWeeklyComparisonDiscord() {
        const ds = dataDate.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
        const previousWeek = monthWeeks.find((w) => w.number === (currentWeek?.number || 1) - 1) || null;
        if (!previousWeek || !currentWeek) return "Not enough weeks to compare yet.";
        const getWeekGain = (member, week) => { const cs = member.cumulativeSeries || []; const endVal = cs[Math.min(week.endDay - 1, cs.length - 1)] ?? 0; const startVal = week.startDay > 1 ? (cs[week.startDay - 2] ?? 0) : 0; return endVal - startVal; };
        const comparisons = decoratedMembers.map((m) => { const prevGain = getWeekGain(m, previousWeek); const currGain = getWeekGain(m, currentWeek); return { name: m.name, prevGain, currGain, diff: currGain - prevGain }; }).sort((a, b) => b.diff - a.diff);
        const improved = comparisons.filter((c) => c.diff > 0); const declined = comparisons.filter((c) => c.diff < 0);
        const lines = [`📊 **[${club.tier}] ${club.name} — Weekly Comparison** | ${ds}`, `🗂️ Source: ${getSourceLabel()}`, `W${previousWeek.number} (${getWeekLabel(previousWeek, year, monthIndex)}) vs W${currentWeek.number} (${getWeekLabel(currentWeek, year, monthIndex)})`, ""];
        if (improved.length > 0) { lines.push(`📈 **Improved** (${improved.length}):`); improved.slice(0, 10).forEach((c) => lines.push(`  ↑ **${c.name}** — W${previousWeek.number}: ${fmt(c.prevGain)} → W${currentWeek.number}: ${fmt(c.currGain)} (${fmtSigned(c.diff)})`)); if (improved.length > 10) lines.push(`  … and ${improved.length - 10} more`); lines.push(""); }
        if (declined.length > 0) { lines.push(`📉 **Declined** (${declined.length}):`); declined.slice(0, 10).forEach((c) => lines.push(`  ↓ **${c.name}** — W${previousWeek.number}: ${fmt(c.prevGain)} → W${currentWeek.number}: ${fmt(c.currGain)} (${fmtSigned(c.diff)})`)); if (declined.length > 10) lines.push(`  … and ${declined.length - 10} more`); }
        lines.push("", `> 🤖 *Dominator Network Tracker · ${getDiscordPingLabel()}*`); let msg = lines.join("\n"); if (msg.length > 3900) msg = msg.slice(0, 3897) + "…"; return msg;
      }

      async function copyWeeklyDiscord() {
        if (!isDiscordExportsEnabled || !navigator.clipboard?.writeText) return;
        await navigator.clipboard.writeText(buildWeeklyComparisonDiscord());
        setWeeklyCopied(true);
        setTimeout(() => setWeeklyCopied(false), 2200);
      }
      async function copyReminderDiscord() {
        const message = buildReminderDiscord();
        const result = await exportDiscordPayload(
          { fullMessage: message, textOnlyMessage: message },
          "under-plan-reminder.png",
          () => renderDiscordMessagePng(message, 2)
        );
        if (!result) return;
        setReminderCopied(result);
        setTimeout(() => setReminderCopied(false), 2200);
      }

      async function captureContainerAsPng(containerEl, scale = 2) {
        if (!containerEl || typeof html2canvas === "undefined") return null;
        try { const canvas = await html2canvas(containerEl, { backgroundColor: "#0a0912", scale, useCORS: true, logging: false, removeContainer: true }); return await new Promise((resolve) => canvas.toBlob(resolve, "image/png")); } catch (e) { console.error("html2canvas export failed:", e); return null; }
      }

      async function exportPaceGraph() {
        const container = paceContainerRef.current; const svg = paceSvgRef.current;
        if (!container && !svg) return; setPaceExporting(true);
        try { let blob = null; if (pacePinnedIdx != null && container) blob = await captureContainerAsPng(container, 2); if (!blob && svg) blob = await svgToPngBlob(svg, 2); if (blob) downloadBlob(blob, `${safeFilename(clubName)}-pace-chart.png`); } finally { setPaceExporting(false); }
      }

      function handleArchiveChange(nextMonth) {
        setArchiveMonth(nextMonth);
        const params = new URLSearchParams(window.location.search);
        if (nextMonth) params.set("month", nextMonth);
        else params.delete("month");
        const query = params.toString();
        window.history.replaceState({}, "", `${window.location.pathname}${query ? `?${query}` : ""}`);
      }

      function selectRankingsTab(nextTab) {
        if (!["home", "clubs", "individual"].includes(nextTab)) return;
        setRankingsTab(nextTab);
        setNetworkMemberVisibleCount(RANKINGS_MEMBER_DEFAULT_COUNT);
        const params = new URLSearchParams(window.location.search);
        if (nextTab === "home") params.delete("section");
        else params.set("section", nextTab);
        const query = params.toString();
        window.history.replaceState({}, "", `${window.location.pathname}${query ? `?${query}` : ""}`);
      }

      function openClub(index) {
        const selectedClub = viewClubs[index];
        if (!selectedClub?.id) return;
        if (PAGE_MODE !== "club") {
          const params = new URLSearchParams({ id: String(selectedClub.id) });
          if (archiveMonth) params.set("month", archiveMonth);
          window.location.assign(`./club.html?${params.toString()}`);
          return;
        }
        setActiveIdx(index);
        setErr("");
        setView("club");
        const params = new URLSearchParams({ id: String(selectedClub.id) });
        if (archiveMonth) params.set("month", archiveMonth);
        window.history.replaceState({}, "", `./club.html?${params.toString()}`);
      }
      function selectClubSummary(index) {
        const selectedClub = viewClubs[index];
        if (!selectedClub?.id) return;
        setClubsPageSelectedIdx(index);
        window.requestAnimationFrame(() => document.getElementById("selected-club-summary")?.scrollIntoView({ behavior: "smooth", block: "start" }));
      }
      function toggleOverviewStatusFilter(statusKey) { setOverviewStatusFilter((prev) => prev === statusKey ? "" : statusKey); }
      function togglePaceMember(name) { setPaceHiddenMembers((prev) => ({ ...prev, [name]: !prev[name] })); }
      function showAllPaceMembers() { setPaceHiddenMembers({}); }
      function hideAllPaceMembers() { const next = {}; decoratedMembers.forEach((member) => { next[member.name] = true; }); setPaceHiddenMembers(next); }
      function showOnlyPaceStatus(statusKey) { const next = {}; decoratedMembers.forEach((member) => { next[member.name] = member.plan.statusKey !== statusKey; }); setPaceHiddenMembers(next); }
      const SORTABLE_MEMBER_COLUMNS = ["fans", "dailyGain", "monthlyGain", "projected", "daysToTarget", "stagnantDays"];
      function updateMemberFilter(key, value) { setMemberFilters((prev) => ({ ...prev, [key]: value })); }
      function clearMemberFilters() { setMemberFilters({ name: "", status: "" }); setMemberSort({ key: "monthlyGain", direction: "desc" }); }
      function handleSort(key) { if (!SORTABLE_MEMBER_COLUMNS.includes(key)) return; setMemberSort((prev) => { if (prev.key !== key || prev.direction === "off") return { key, direction: "desc" }; if (prev.direction === "desc") return { key, direction: "asc" }; return { key: null, direction: "off" }; }); }
      function sortIndicator(key) { if (!SORTABLE_MEMBER_COLUMNS.includes(key)) return ""; if (memberSort.key !== key || memberSort.direction === "off") return "OFF"; return memberSort.direction === "asc" ? "ASC" : "DESC"; }
      function matchesSelectFilter(value, filterValue) { if (!filterValue) return true; return String(value ?? "") === String(filterValue); }
      function getMemberSortValue(member, key) { return member[key] ?? Number.NEGATIVE_INFINITY; }
      const memberNameOptions = [...new Set(decoratedMembers.map((member) => member.name).filter(Boolean))].sort((a, b) => a.localeCompare(b));
      const memberRows = (() => {
        const filtered = decoratedMembers.filter((member) => matchesSelectFilter(member.name, memberFilters.name) && matchesSelectFilter(getDisplayStatusKey(member.plan.statusKey), memberFilters.status));
        const sorted = memberSort.key && memberSort.direction !== "off" ? [...filtered].sort((a, b) => { const av = getMemberSortValue(a, memberSort.key); const bv = getMemberSortValue(b, memberSort.key); const dir = memberSort.direction === "asc" ? 1 : -1; if (av === bv) return (a.name || "").localeCompare(b.name || ""); return ((av > bv) ? 1 : -1) * dir; }) : filtered;
        return sorted.map((member, index) => ({ member, rank: index + 1 }));
      })();
      const currentWeek = findWeekForDay(monthWeeks, today);

      const S = {
        root: { background: "transparent", minHeight: "100vh", color: "#e2e0f0", fontFamily: "'Inter',system-ui,sans-serif", padding: "16px", maxWidth: 1480, margin: "0 auto" },
        card: {
          background: "linear-gradient(168deg, rgba(34,29,66,0.66) 0%, rgba(18,15,38,0.86) 52%, rgba(13,11,29,0.92) 100%)",
          border: "1px solid rgba(167,139,250,0.16)",
          borderRadius: 16,
          padding: "16px 18px",
          marginBottom: 14,
          boxShadow: "0 1px 0 rgba(226,224,240,0.05) inset, 0 14px 36px rgba(3,2,10,0.55), 0 0 0 0.5px rgba(124,58,237,0.06)",
        },
        h2: { fontSize: 11, fontWeight: 800, color: "#8f88b8", textTransform: "uppercase", letterSpacing: "0.16em", margin: "0 0 14px", paddingLeft: 10, borderLeft: "3px solid #7c3aed", lineHeight: 1.2 },
        btn: (active, col = "#7c3aed") => ({
          background: active ? `linear-gradient(150deg, ${col}, ${col}cc)` : "rgba(20,17,40,0.85)",
          color: active ? "#fff" : "#8f88b8",
          border: `1px solid ${active ? col : "rgba(167,139,250,0.18)"}`,
          borderRadius: 999,
          padding: "7px 15px",
          cursor: "pointer",
          fontSize: 12,
          fontWeight: 700,
          letterSpacing: "0.01em",
          boxShadow: active ? `0 4px 16px ${col}55, 0 0 0 1px ${col}33 inset` : "none",
          transition: "all 0.15s",
        }),
        input: { width: "100%", background: "rgba(11,9,24,0.85)", border: "1px solid rgba(167,139,250,0.22)", color: "#e2e0f0", borderRadius: 9, padding: "7px 9px", fontSize: 11 },
        th: { padding: "10px 8px", borderBottom: "1px solid rgba(167,139,250,0.18)", color: "#8f88b8", fontSize: 10.5, fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.06em", whiteSpace: "nowrap" },
        td: { padding: "10px 8px", borderBottom: "1px solid rgba(30,27,53,0.85)", fontSize: 12, verticalAlign: "middle" },
      };

      const accent = view === "home" ? "#c4b5fd" : tc.text;
      const discordActionsBlocked = false;
      const actionButtonDisabledStyle = (resetWindowBlocksExports || discordActionsBlocked) ? { opacity: 0.45, cursor: "not-allowed", filter: "saturate(0.5)" } : null;
      const actionButtonTitle = resetWindowBlocksExports ? "Available after the current Chronogenesis day is confirmed." : "";
      const clubDetailParams = new URLSearchParams();
      if (cid) clubDetailParams.set("id", String(cid));
      if (archiveMonth) clubDetailParams.set("month", archiveMonth);
      const clubDetailHref = `./club.html${clubDetailParams.toString() ? `?${clubDetailParams.toString()}` : ""}`;
      const insightsHref = "./archives.html";
      const navLinkStyle = (active, color) => ({ ...S.btn(active, color), display: "flex", alignItems: "center", gap: 8, width: "100%", textDecoration: "none" });

      return (
        <div style={S.root}>
          {/* ── Mobile top bar ── */}
          <div className="mobile-topbar">
            <div style={{ display: "flex", alignItems: "center", gap: 9, minWidth: 0 }}>
              <span className="gate-badge" style={{ width: 30, height: 30, borderRadius: 9, fontSize: 16 }}>⬡</span>
              <div style={{ minWidth: 0 }}>
                <div className="wordmark" style={{ fontSize: 15 }}>Dominator Network</div>
                <div style={{ color: "#8f88b8", fontSize: 9, fontWeight: 700 }}>Day {today}/{dim} · {daysLeft} left{isArchiveView ? ` · 📦 ${archiveMonth}` : ""}</div>
              </div>
            </div>
            <div className="telemetry" style={{ flex: "0 0 auto", textAlign: "right" }}>
              <div style={{ color: loading ? "#34d399" : "#8f88b8", fontSize: 8, fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.12em" }}>{loading ? "Refreshing…" : "Next refresh"}</div>
              <RefreshCountdown style={{ color: "#e2e0f0", fontSize: 14, fontWeight: 700 }} />
            </div>
          </div>

          <div className="app-shell">
            {/* ── Paddock rail (desktop) ── */}
            <aside className="rail">
              <div>
                <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
                  <span className="gate-badge">⬡</span>
                  <div>
                    <div className="wordmark" style={{ fontSize: 19 }}>Dominator Network</div>
                    <div className="wordmark-sub">Umamusume · Fan Tracker</div>
                  </div>
                </div>
                <div className="finish-ribbon" aria-hidden="true" style={{ margin: "12px 0 0" }}></div>
                <div style={{ color: "#8f88b8", fontSize: 11, marginTop: 10, lineHeight: 1.5 }}>{dataDate.toLocaleString("en-US", { month: "long", day: "numeric", year: "numeric" })} · <span style={{ color: "#c4b5fd", fontWeight: 700 }}>Day {today}/{dim}</span><br/>{daysLeft} days left · Chronogenesis{isArchiveView ? ` · 📦 ${archiveMonth}` : ""}</div>
              </div>

              <div style={{ ...S.card, marginBottom: 0, padding: "12px 13px" }}>
                <div style={S.h2}>Navigation</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <a href="./index.html" style={navLinkStyle(PAGE_MODE === "home", "#7c3aed")}>🏠 Home</a>
                  <a href="./clubs.html" style={navLinkStyle(PAGE_MODE === "clubs", "#7c3aed")}>📋 Clubs</a>
                  <a href="./rankings.html" style={navLinkStyle(PAGE_MODE === "rankings", "#2563eb")}>🌐 Rankings</a>
                  <a href={clubDetailHref} style={navLinkStyle(PAGE_MODE === "club", tc.bar)}>🏇 Club Detail</a>
                  <a href={insightsHref} style={navLinkStyle(PAGE_MODE === "archives", "#a78bfa")}>🔎 Deeper Insights</a>
                </div>
                <div style={{ marginTop: 12 }}>
                  <div style={{ color: "#6b7280", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 6 }}>Data Source</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    <span style={{ background: "#1d4ed8", color: "#ffffff", border: "1px solid #3b82f6", borderRadius: 999, padding: "6px 12px", fontSize: 11, fontWeight: 800, textAlign: "center" }}>Chronogenesis</span>
                    <select value={archiveMonth} onChange={(e) => handleArchiveChange(e.target.value)} style={{ background: "rgba(11,9,24,0.72)", border: "1px solid #1e1b35", color: "#e2e0f0", borderRadius: 8, padding: "8px 10px", fontSize: 11, fontWeight: 700, width: "100%" }}>
                      <option value="">Live current month</option>
                      {archiveMonths.map((month) => <option key={month.key || month} value={month.key || month}>Archive: {month.label || getMonthKeyLabel(month.key || month)}</option>)}
                    </select>
                  </div>
                </div>
              </div>

              {view === "club" && (
                <div style={{ ...S.card, marginBottom: 0, padding: "12px 13px" }}>
                  <div style={S.h2}>Starting Gates</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    {viewClubs.map((entry, index) => {
                      const active = index === activeIdx;
                      const hasData = entry.id && clubData[entry.id];
                      return (
                        <button key={entry.name} onClick={() => openClub(index)} className={`gate-btn${active ? " active" : ""}`} style={{ opacity: entry.id ? 1 : 0.6 }}>
                          <span className="gate-num">{index + 1}</span>
                          <TierIcon tier={entry.tier} size={16} title={`${entry.tier} tier`} showFallbackText={true} rankingConfig={viewRankingConfig} rankIconPath={viewRankIconPath} />
                          <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{entry.name}</span>
                          {hasData && <span style={{ width: 5, height: 5, borderRadius: "50%", background: "#34d399", flexShrink: 0, marginLeft: "auto", boxShadow: "0 0 6px #34d399" }} />}
                          {!entry.id && <span style={{ fontSize: 9, color: "#4b5563", marginLeft: "auto" }}>soon</span>}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              <div style={{ minWidth: 0, background: "rgba(11,9,24,0.72)", border: `1px solid ${loading ? "#34d39955" : liveStatus.border}`, borderRadius: 12, padding: "10px 11px" }}>
                <div style={{ color: loading ? "#34d399" : "#a78bfa", fontSize: 10, fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.5px" }}>{loading ? "Refreshing scheduled JSON…" : "Next scheduled refresh"}</div>
                <RefreshCountdown onCycleStart={handleScheduledRefreshCycle} style={{ color: "#e2e0f0", fontSize: 19, fontWeight: 700, lineHeight: 1.15 }} />
                <div style={{ color: "#9ca3af", fontSize: 10, marginTop: 2 }}>{nextRefreshDateLabel}</div>
                <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 2, padding: "6px 8px", borderRadius: 8, border: `1px solid ${liveStatus.border}`, background: liveStatus.bg }}>
                  <div style={{ color: liveStatus.color, fontSize: 11, fontWeight: 800 }}>{liveStatus.label}</div>
                  <div style={{ color: "#cfcbe6", fontSize: 9, lineHeight: 1.3 }}>{liveStatus.sub}</div>
                </div>
                <div style={{ color: "#6b7280", fontSize: 10, marginTop: 5, lineHeight: 1.25 }}>Upcoming {refreshScheduleMeta.label}: {upcomingRefreshLabel || "—"}</div>
              </div>
            </aside>

            {/* ── Track (main content) ── */}
            <main className="main">
              <div className="mobile-only" style={{ marginBottom: 12 }}>
                <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginBottom: view === "club" ? 10 : 0 }}>
                  <span style={{ background: "#1d4ed8", color: "#ffffff", border: "1px solid #3b82f6", borderRadius: 999, padding: "6px 11px", fontSize: 11, fontWeight: 800 }}>Chronogenesis</span>
                  <select value={archiveMonth} onChange={(e) => handleArchiveChange(e.target.value)} style={{ flex: 1, minWidth: 150, background: "rgba(11,9,24,0.85)", border: "1px solid #1e1b35", color: "#e2e0f0", borderRadius: 8, padding: "8px 10px", fontSize: 11, fontWeight: 700 }}>
                    <option value="">Live current month</option>
                    {archiveMonths.map((month) => <option key={month.key || month} value={month.key || month}>Archive: {month.label || getMonthKeyLabel(month.key || month)}</option>)}
                  </select>
                </div>
                {view === "club" && (
                  <div className="gate-strip">
                    {viewClubs.map((entry, index) => {
                      const active = index === activeIdx;
                      const hasData = entry.id && clubData[entry.id];
                      return (
                        <button key={entry.name} onClick={() => openClub(index)} className={`gate-btn${active ? " active" : ""}`} style={{ opacity: entry.id ? 1 : 0.6 }}>
                          <span className="gate-num">{index + 1}</span>
                          <TierIcon tier={entry.tier} size={15} title={`${entry.tier} tier`} showFallbackText={true} rankingConfig={viewRankingConfig} rankIconPath={viewRankIconPath} />
                          <span>{entry.name}</span>
                          {hasData && <span style={{ width: 5, height: 5, borderRadius: "50%", background: "#34d399", flexShrink: 0 }} />}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>

              {view === "club" && (
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}>
                  <button style={{ ...S.btn(false, weeklyCopied ? "#059669" : "#60a5fa"), ...(actionButtonDisabledStyle || {}) }} onClick={copyWeeklyDiscord} disabled={!decoratedMembers.length || resetWindowBlocksExports || discordActionsBlocked} title={actionButtonTitle}>{weeklyCopied ? "✓ Weekly Copied!" : "📊 Weekly Comparison"}</button>
                  <button style={{ ...S.btn(false, reminderCopied ? "#059669" : "#f59e0b"), ...(actionButtonDisabledStyle || {}) }} onClick={copyReminderDiscord} disabled={!decoratedMembers.length || resetWindowBlocksExports || discordActionsBlocked} title={actionButtonTitle}>{reminderCopied ? (reminderCopied === "image" ? "✓ Copied + PNG" : reminderCopied === "shared" ? "✓ Shared" : "✓ Reminder Copied!") : "🔔 Under Plan Reminder"}</button>
                  <button style={{ ...S.btn(true, copied ? "#059669" : tc.bar), ...(actionButtonDisabledStyle || {}) }} onClick={copyDiscord} disabled={!decoratedMembers.length || resetWindowBlocksExports || discordActionsBlocked} title={actionButtonTitle}>{copied ? (copied === "image" ? "✓ Copied + PNG" : copied === "shared" ? "✓ Shared" : "✓ Copied!") : "💬 Discord + PNG"}</button>
                </div>
              )}
          {err && (<div style={{ background: "#450a0a", border: "1px solid #7f1d1d", borderRadius: 12, padding: "12px 16px", marginBottom: 14, color: "#fca5a5", fontSize: 12 }}>⚠️ {err}</div>)}

          {view === "home" && (<>
            {PAGE_MODE === "home" && (<>
              <div style={S.card}>
                <div style={S.h2}>Network Home</div>
                <div style={{ color: "#e2e0f0", fontSize: 24, fontWeight: 800, marginBottom: 6 }}>Dominator Network Overview</div>
                <div style={{ color: "#8f88b8", fontSize: 13, lineHeight: 1.6 }}>Use this page as the network-wide starting point. The live statistics below summarize every loaded club; choose a destination for the detailed views.</div>
              </div>
              <div className="stat-strip">
                {[
                  { label: "Tracked Clubs", value: `${loadedClubCount}/${viewClubs.filter((entry) => entry.id).length}`, sub: "Loaded club data", col: "#e2e0f0" },
                  { label: "Network Monthly +", value: hasComparisonData ? fmt(networkMonthlyTotal) : "—", sub: hasComparisonData ? "Across loaded clubs" : noComparisonLabel, col: hasComparisonData ? "#c4b5fd" : "#9ca3af" },
                  { label: "Network Fans", value: fmt(networkFanTotal), sub: "Active members only", col: "#34d399" },
                  { label: "Active Members", value: hasComparisonData ? networkMemberCount : "—", sub: hasComparisonData ? `${clubsMissingData} clubs missing JSON` : noComparisonLabel, col: hasComparisonData ? (clubsMissingData ? "#fbbf24" : "#34d399") : "#9ca3af" },
                  { label: `${STATUS_META["on-track"].icon} On Track`, value: hasComparisonData ? networkStatusCounts["on-track"] : "—", sub: hasComparisonData ? "Members at or above plan" : noComparisonLabel, col: STATUS_META["on-track"].color },
                  { label: `${STATUS_META["behind"].icon} Behind`, value: hasComparisonData ? networkStatusCounts["behind"] : "—", sub: hasComparisonData ? "Members below plan" : noComparisonLabel, col: STATUS_META["behind"].color },
                  { label: `${STATUS_META["critical"].icon} Critical`, value: hasComparisonData ? networkStatusCounts["critical"] : "—", sub: hasComparisonData ? "Members under 25% of plan" : noComparisonLabel, col: STATUS_META["critical"].color },
                  { label: "Members At/Above Plan", value: hasComparisonData ? `${networkMembersAtOrAbovePlan}/${networkMemberCount}` : "—", sub: hasComparisonData ? `${loadedClubCount} clubs loaded · ${clubsMissingData} missing JSON` : noComparisonLabel, col: hasComparisonData && networkMembersAtOrAbovePlan === networkMemberCount && networkMemberCount > 0 ? "#34d399" : "#c4b5fd" },
                ].map((card) => (<div key={card.label} style={{ ...S.card, marginBottom: 0, padding: "13px 15px", minWidth: 0 }}><div style={{ color: "#4b5563", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 4 }}>{card.label}</div><div style={{ color: card.col, fontSize: 22, fontWeight: 800 }}>{card.value}</div><div style={{ color: "#6b7280", fontSize: 11, marginTop: 3 }}>{card.sub}</div></div>))}
              </div>
              <div style={S.card}>
                <div style={S.h2}>Navigate the Tracker</div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))", gap: 12 }}>
                  {[
                    { href: "./clubs.html", icon: "📋", title: "Clubs", description: "Browse every club and open a focused high-level club summary.", color: "#7c3aed" },
                    { href: "./rankings.html", icon: "🌐", title: "Rankings", description: "Explore club rankings, member leaderboards, pace, health, and movement insights.", color: "#2563eb" },
                    { href: clubDetailHref, icon: "🏇", title: "Club Detail", description: "Open the full Overview, Members, and Pace dashboard for a single club.", color: tc.bar },
                    { href: insightsHref, icon: "🔎", title: "Deeper Insights", description: "Reserved for the deeper analysis features you choose next.", color: "#a78bfa" },
                  ].map((item) => (
                    <a key={item.title} href={item.href} style={{ background: "rgba(11,9,24,0.72)", border: `1px solid ${item.color}55`, borderRadius: 14, padding: "18px", textDecoration: "none", display: "block", boxShadow: `0 0 0 1px ${item.color}11 inset` }}>
                      <div style={{ fontSize: 24, marginBottom: 10 }}>{item.icon}</div>
                      <div style={{ color: "#f1eefc", fontSize: 16, fontWeight: 800, marginBottom: 6 }}>{item.title}</div>
                      <div style={{ color: "#8f88b8", fontSize: 12, lineHeight: 1.55 }}>{item.description}</div>
                    </a>
                  ))}
                </div>
              </div>
            </>)}

            {PAGE_MODE === "clubs" && (<>
              <div style={S.card}>
                <div style={S.h2}>Club Directory</div>
                <div style={{ color: "#6b7280", fontSize: 12, marginBottom: 12 }}>Hover the pace bar for exact figures. The dot next to JSON shows load status.</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {networkClubs.map((entry, index) => {
                    const ctc = viewTierColors[entry.tier] || viewTierColors["B+"];
                    const monthPct = entry.hasData && entry.clubTarget > 0 ? Math.min(100, (entry.totalMonthly / entry.clubTarget) * 100) : 0;
                    const planDelta = entry.hasData && hasComparisonData ? entry.totalMonthly - entry.totalExpected : null;
                    const onPace = planDelta != null && planDelta >= 0;
                    return (
                      <div
                        key={entry.name}
                        className={`dir-row${clubsPageSelectedIdx === index ? " selected" : ""}`}
                        role="button"
                        tabIndex={0}
                        aria-pressed={clubsPageSelectedIdx === index}
                        onClick={() => selectClubSummary(index)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            selectClubSummary(index);
                          }
                        }}
                        style={{ borderLeft: `3px solid ${entry.hasData ? ctc.border : "#1e1b35"}` }}
                      >
                        <div className="dir-id">
                          <span className="gate-num" style={{ borderColor: entry.hasData ? ctc.border + "66" : undefined }}>{index + 1}</span>
                          <TierBadge tier={entry.tier} rankingConfig={viewRankingConfig} rankIconPath={viewRankIconPath} />
                        </div>
                        <div className="dir-name">
                          <div style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0 }}>
                            <span style={{ fontWeight: 800, color: "#f1eefc", fontSize: 14, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{entry.clubName}</span>
                            {entry.currentMonthlyRank != null && <MonthlyRankBadge rank={entry.currentMonthlyRank} delta={entry.rankDelta} size="small" rankingConfig={viewRankingConfig} rankIconPath={viewRankIconPath} />}
                          </div>
                          <div style={{ color: "#6b7280", fontSize: 10, marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{entry.officer} · <span style={{ color: ctc.text, fontWeight: 700 }}>{fmt(entry.target)}</span>/member · {hasComparisonData ? `${entry.activeMembers}/${viewMaxMembers} active` : noComparisonLabel}</div>
                        </div>
                        <div className="dir-stats">
                          <div>
                            <div className="dir-stat-label">Monthly</div>
                            <div style={{ color: entry.hasData && hasComparisonData ? "#f1eefc" : "#9ca3af", fontWeight: 800, fontSize: 13 }}>{entry.hasData && hasComparisonData ? fmt(entry.totalMonthly) : "—"}</div>
                            {planDelta != null && <div style={{ color: onPace ? "#34d399" : "#f87171", fontSize: 10, fontWeight: 700 }}>{fmtSigned(planDelta)} vs plan</div>}
                          </div>
                          <div>
                            <div className="dir-stat-label">Daily</div>
                            <div style={{ color: entry.hasData && entry.totalDaily != null ? "#cfcbe6" : "#9ca3af", fontWeight: 800, fontSize: 13 }}>{entry.hasData && entry.totalDaily != null ? fmt(entry.totalDaily) : "—"}</div>
                            {entry.hasData && hasComparisonData ? <DailyTrendIndicator delta={entry.dailyTrendDelta} /> : null}
                          </div>
                          <div>
                            <div className="dir-stat-label">Prev Day</div>
                            <div style={{ color: entry.hasData && entry.previousDaily != null ? "#c4b5fd" : "#9ca3af", fontWeight: 800, fontSize: 13 }}>{entry.hasData && entry.previousDaily != null ? fmt(entry.previousDaily) : "—"}</div>
                            {entry.hasData && today > 1 && <div style={{ color: "#5b5680", fontSize: 10 }}>Day {today - 1}</div>}
                          </div>
                        </div>
                        <div className="dir-actions">
                          <span title={entry.jsonMeta.sub} style={{ display: "inline-flex", alignItems: "center", gap: 5, color: entry.jsonMeta.color, fontSize: 10, fontWeight: 700, whiteSpace: "nowrap" }}>
                            <span style={{ width: 7, height: 7, borderRadius: 999, background: entry.jsonMeta.color, boxShadow: `0 0 6px ${entry.jsonMeta.color}`, flexShrink: 0 }} />JSON
                          </span>
                          <span className="dir-select-label" style={{ color: clubsPageSelectedIdx === index ? ctc.text : "#8f88b8", borderColor: clubsPageSelectedIdx === index ? `${ctc.border}88` : undefined }}>{clubsPageSelectedIdx === index ? "Selected" : "Select club"}</span>
                        </div>
                        <div className="dir-bar" title={entry.hasData && hasComparisonData ? `${fmtFull(entry.totalMonthly)} of ${fmtFull(entry.clubTarget)} club target (${monthPct.toFixed(1)}%)` : "No data yet"}>
                          <div style={{ flex: 1 }}><ProgressBar pct={monthPct} color={onPace ? "#34d399" : entry.hasData && hasComparisonData ? "#f59e0b" : "#2a2540"} height={5} /></div>
                          <span className="telemetry" style={{ color: entry.hasData && hasComparisonData ? (onPace ? "#34d399" : "#fbbf24") : "#5b5680", fontSize: 11, fontWeight: 700, minWidth: 44, textAlign: "right" }}>{entry.hasData && hasComparisonData ? `${monthPct.toFixed(1)}%` : "—"}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {(() => {
                const entry = networkClubs[clubsPageSelectedIdx] || networkClubs[0];
                if (!entry) return null;
                const ctc = viewTierColors[entry.tier] || viewTierColors["B+"];
                const monthPct = entry.hasData && entry.clubTarget > 0 ? Math.min(100, (entry.totalMonthly / entry.clubTarget) * 100) : 0;
                const planDelta = entry.hasData && hasComparisonData ? entry.totalMonthly - entry.totalExpected : null;
                return (
                  <div id="selected-club-summary" style={{ ...S.card, border: `1px solid ${ctc.border}55`, scrollMarginTop: 18 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start", flexWrap: "wrap", marginBottom: 14 }}>
                      <div>
                        <div style={S.h2}>Selected Club — High-Level Stats</div>
                        <div style={{ display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap" }}>
                          <TierBadge tier={entry.tier} rankingConfig={viewRankingConfig} rankIconPath={viewRankIconPath} />
                          <span style={{ color: "#f1eefc", fontSize: 21, fontWeight: 800 }}>{entry.clubName}</span>
                          {entry.currentMonthlyRank != null && <MonthlyRankBadge rank={entry.currentMonthlyRank} delta={entry.rankDelta} rankingConfig={viewRankingConfig} rankIconPath={viewRankIconPath} />}
                        </div>
                        <div style={{ color: "#8f88b8", fontSize: 11, marginTop: 6 }}>{entry.officer} · {fmt(entry.target)} per member · Club ID {entry.id}</div>
                      </div>
                      <button style={S.btn(true, ctc.bar)} onClick={() => openClub(clubsPageSelectedIdx)}>Open full club detail →</button>
                    </div>
                    {!entry.hasData ? (
                      <div style={{ background: "rgba(11,9,24,0.72)", border: "1px solid #1e1b35", borderRadius: 12, padding: "16px", color: "#8f88b8", fontSize: 12 }}>No Chronogenesis JSON is currently loaded for this club.</div>
                    ) : (
                      <>
                        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(145px, 1fr))", gap: 10, marginBottom: 14 }}>
                          {[
                            { label: "Active Members", value: `${entry.activeMembers}/${viewMaxMembers}`, col: "#e2e0f0" },
                            { label: "Monthly Gain", value: hasComparisonData ? fmt(entry.totalMonthly) : "—", col: "#c4b5fd" },
                            { label: "Daily Gain", value: entry.totalDaily != null ? fmt(entry.totalDaily) : "—", col: "#e2e0f0" },
                            { label: "Projected", value: hasComparisonData ? fmt(entry.totalProjected) : "—", col: "#a78bfa" },
                            { label: "Total Fans", value: fmt(entry.totalFans), col: "#34d399" },
                            { label: "Health", value: hasComparisonData ? `${entry.health.grade} · ${entry.health.score}` : "—", col: hasComparisonData ? entry.health.color : "#9ca3af" },
                          ].map((item) => (<div key={item.label} style={{ background: "rgba(11,9,24,0.72)", border: "1px solid #1e1b35", borderRadius: 11, padding: "11px 13px" }}><div style={{ color: "#4b5563", fontSize: 9, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 4 }}>{item.label}</div><div style={{ color: item.col, fontSize: 17, fontWeight: 800 }}>{item.value}</div></div>))}
                        </div>
                        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 10, marginBottom: 14 }}>
                          {["on-track", "behind", "critical"].map((statusKey) => { const meta = STATUS_META[statusKey]; return (<div key={statusKey} style={{ background: meta.bg, border: `1px solid ${meta.border}`, borderRadius: 10, padding: "10px 12px" }}><div style={{ color: meta.color, fontSize: 11, fontWeight: 800 }}>{meta.icon} {meta.label}</div><div style={{ color: "#f1eefc", fontSize: 18, fontWeight: 800, marginTop: 3 }}>{hasComparisonData ? entry.statusCounts[statusKey] : "—"}</div></div>); })}
                        </div>
                        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
                          <div style={{ flex: 1, minWidth: 220 }}><ProgressBar pct={monthPct} color={planDelta != null && planDelta >= 0 ? "#34d399" : "#f59e0b"} height={8} /></div>
                          <div className="telemetry" style={{ color: planDelta != null && planDelta >= 0 ? "#34d399" : "#fbbf24", fontSize: 12, fontWeight: 800 }}>{hasComparisonData ? `${monthPct.toFixed(1)}% of club target · ${fmtSigned(planDelta)} vs plan` : noComparisonLabel}</div>
                        </div>
                      </>
                    )}
                  </div>
                );
              })()}
            </>)}

            {PAGE_MODE === "rankings" && (<>
              <div style={S.card}>
                <div style={S.h2}>Network Rankings</div>
                <div style={{ color: "#e2e0f0", fontSize: 22, fontWeight: 800, marginBottom: 6 }}>Club and Individual Ranking Insights</div>
                <div style={{ color: "#8f88b8", fontSize: 12, lineHeight: 1.6 }}>Choose a focused view for network trends, club-level comparisons, or individual member rankings.</div>
              </div>

              <div className="tab-dock" aria-label="Ranking sections">
                {[
                  ["home", "🏠 Rankings Home"],
                  ["clubs", "🏇 Club Rankings"],
                  ["individual", "👤 Individual Rankings"],
                ].map(([sectionKey, label]) => (
                  <button
                    key={sectionKey}
                    style={S.btn(rankingsTab === sectionKey, rankingsTab === sectionKey ? "#7c3aed" : undefined)}
                    onClick={() => selectRankingsTab(sectionKey)}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {rankingsTab === "clubs" && (<div id="club-rankings-section" style={S.card}>
                <div style={S.h2}>Club Rankings</div>
                <div style={{ color: "#6b7280", fontSize: 12, marginBottom: 12 }}>Current monthly rank for every loaded club, ordered from best rank to lowest.</div>
                <div style={{ overflowX: "auto" }}><table style={{ width: "100%", borderCollapse: "collapse" }}><thead><tr style={{ textAlign: "left" }}><th style={S.th}>Monthly Rank</th><th style={S.th}>Club</th><th style={S.th}>Network Tier</th><th style={S.th}>Monthly Gain</th><th style={S.th}>Projected</th><th style={S.th}>Health</th><th style={S.th}>Detail</th></tr></thead><tbody>
                  {rankedNetworkClubs.length === 0 ? (<tr><td colSpan={7} style={{ ...S.td, textAlign: "center", color: "#6b7280", padding: "22px 8px" }}>No club ranking data is available yet.</td></tr>) : rankedNetworkClubs.map((entry) => (
                    <tr key={`club-rank-${entry.id}`}>
                      <td style={S.td}>{entry.currentMonthlyRank != null ? <MonthlyRankBadge rank={entry.currentMonthlyRank} delta={entry.rankDelta} rankingConfig={viewRankingConfig} rankIconPath={viewRankIconPath} /> : <span style={{ color: "#6b7280" }}>—</span>}</td>
                      <td style={{ ...S.td, color: "#e2e0f0", fontWeight: 800 }}>{entry.clubName}</td>
                      <td style={S.td}><TierBadge tier={entry.tier} rankingConfig={viewRankingConfig} rankIconPath={viewRankIconPath} /></td>
                      <td style={{ ...S.td, color: gainColor(entry.totalMonthly), fontWeight: 700 }}>{hasComparisonData ? fmtSigned(entry.totalMonthly) : "—"}</td>
                      <td style={{ ...S.td, color: "#c4b5fd", fontWeight: 700 }}>{hasComparisonData ? fmt(entry.totalProjected) : "—"}</td>
                      <td style={S.td}>{hasComparisonData ? <HealthBadge grade={entry.health.grade} /> : <span style={{ color: "#6b7280" }}>—</span>}</td>
                      <td style={S.td}><a href={`./club.html?id=${encodeURIComponent(entry.id)}${archiveMonth ? `&month=${encodeURIComponent(archiveMonth)}` : ""}`} style={{ ...S.btn(false, entry.clubColor), display: "inline-flex", textDecoration: "none" }}>Open →</a></td>
                    </tr>
                  ))}
                </tbody></table></div>
              </div>)}

              {rankingsTab === "individual" && (<div id="individual-member-rankings" style={S.card}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center", flexWrap: "wrap", marginBottom: 8 }}><div style={S.h2}>Individual Member Rankings</div><div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}><button style={S.btn(topNetworkMode === "daily", "#7c3aed")} onClick={() => setTopNetworkMode("daily")}>Daily Gain</button><button style={S.btn(topNetworkMode === "monthly", "#7c3aed")} onClick={() => setTopNetworkMode("monthly")}>Monthly Gain</button></div></div>
                <div style={{ color: "#6b7280", fontSize: 12, marginBottom: 6 }}>{topNetworkMode === "daily" ? "Members are ranked by daily gain to spotlight the hottest performers right now, with total fans shown for context." : "Members are ranked by monthly fans to spotlight the strongest performers this month, with total fans shown for context."}</div>
                {hasComparisonData && topNetworkUsers.length > 0 && (<div style={{ color: "#8f88b8", fontSize: 11, marginBottom: 12 }}>Showing the top {visibleNetworkUsers.length} of {topNetworkUsers.length} members.</div>)}
                {hasComparisonData && topNetworkUsers.length > 0 && (
                  <div className="podium">
                    {topNetworkUsers.slice(0, 3).map((member, index) => {
                      const ps = getPodiumStyle(index);
                      const value = topNetworkMode === "daily" ? member.dailyGain : member.monthlyGain;
                      return (
                        <div key={`podium-${member.clubName}-${member.name}`} className={`podium-step podium-${index + 1}`}>
                          <div className="podium-rank" style={{ color: ps.color, textShadow: ps.textShadow }}>{index === 0 ? "🥇" : index === 1 ? "🥈" : "🥉"}</div>
                          <div style={{ color: "#f1eefc", fontWeight: 800, fontSize: index === 0 ? 14 : 12, marginTop: 6, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{member.name}</div>
                          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 5, marginTop: 4, color: "#8f88b8", fontSize: 10, minWidth: 0 }}><TierBadge tier={member.clubTier} size={14} rankingConfig={viewRankingConfig} rankIconPath={viewRankIconPath} /><span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{member.clubName}</span></div>
                          <div className="telemetry" style={{ color: ps.color, fontWeight: 700, fontSize: index === 0 ? 18 : 15, marginTop: 7 }}>{value != null ? fmtSigned(value) : "—"}</div>
                          <div style={{ color: "#6b7280", fontSize: 9, marginTop: 2 }}>{fmt(member.fans)} total fans</div>
                        </div>
                      );
                    })}
                  </div>
                )}
                <div style={{ overflowX: "auto" }}><table style={{ width: "100%", borderCollapse: "collapse" }}><thead><tr style={{ textAlign: "left" }}><th style={S.th}>#</th><th style={S.th}>Member</th><th style={S.th}>Club</th>{topNetworkMode === "daily" ? <th style={S.th}>Daily Gain</th> : <th style={S.th}>Monthly Fans</th>}<th style={S.th}>Total Fans</th></tr></thead><tbody>
                  {!hasComparisonData ? (<tr><td colSpan={5} style={{ ...S.td, textAlign: "center", color: "#6b7280", padding: "22px 8px" }}>{noComparisonLabel}</td></tr>) : topNetworkUsers.length === 0 ? (<tr><td colSpan={5} style={{ ...S.td, textAlign: "center", color: "#6b7280", padding: "22px 8px" }}>Load club JSON files to populate the network leaderboard.</td></tr>) : (
                    visibleNetworkUsers.slice(3).map((member, index) => (<tr key={`${member.clubName}-${member.name}-${index}`}><td style={{ ...S.td, color: "#6b7280" }}>{index + 4}</td><td style={{ ...S.td, color: "#e2e0f0", fontWeight: 700 }}>{member.name}</td><td style={S.td}><div style={{ display: "flex", alignItems: "center", gap: 8 }}><TierBadge tier={member.clubTier} rankingConfig={viewRankingConfig} rankIconPath={viewRankIconPath} /><span>{member.clubName}</span></div></td>{topNetworkMode === "daily" ? (<td style={{ ...S.td, color: gainColor(member.dailyGain), fontWeight: 700 }}>{member.dailyGain != null ? fmtSigned(member.dailyGain) : "—"}</td>) : (<td style={{ ...S.td, color: gainColor(member.monthlyGain), fontWeight: 700 }}>{fmtSigned(member.monthlyGain ?? 0)}</td>)}<td style={{ ...S.td, color: "#e2e0f0", fontWeight: 700 }}>{fmtFull(member.fans)}</td></tr>))
                  )}
                </tbody></table></div>
                {topNetworkUsers.length > RANKINGS_MEMBER_DEFAULT_COUNT && (
                  <div style={{ display: "flex", justifyContent: "center", marginTop: 12 }}>
                    {remainingNetworkUserCount > 0 ? (
                      <button
                        style={S.btn(false, "#7c3aed")}
                        onClick={() => setNetworkMemberVisibleCount((previousCount) => Math.min(topNetworkUsers.length, previousCount + RANKINGS_MEMBER_PAGE_SIZE))}
                      >
                        Show next {Math.min(RANKINGS_MEMBER_PAGE_SIZE, remainingNetworkUserCount)} members
                      </button>
                    ) : (
                      <button style={S.btn(false, "#7c3aed")} onClick={() => setNetworkMemberVisibleCount(RANKINGS_MEMBER_DEFAULT_COUNT)}>
                        Hide {hiddenOnNetworkResetCount} members
                      </button>
                    )}
                  </div>
                )}
              </div>)}

              {rankingsTab === "clubs" && (<div id="top-five-by-club" style={S.card}>
                <div style={S.h2}>Top Five Players by Club</div>
                <div style={{ color: "#6b7280", fontSize: 12, marginBottom: 12 }}>Top five monthly fan gainers in each loaded club, with daily gain for quick comparison.</div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 10 }}>
                  {networkClubs.filter((entry) => entry.id).map((entry) => {
                    const ctc = viewTierColors[entry.tier] || viewTierColors["B+"];
                    return (
                      <div key={`top-five-${entry.name}`} style={{ background: "rgba(11,9,24,0.72)", border: `1px solid ${entry.hasData ? ctc.border + "55" : "#1e1b35"}`, borderRadius: 12, padding: "13px 14px" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center", marginBottom: 10 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 8 }}><TierBadge tier={entry.tier} rankingConfig={viewRankingConfig} rankIconPath={viewRankIconPath} /><div style={{ color: "#e2e0f0", fontWeight: 800, fontSize: 14 }}>{entry.clubName}</div></div>
                          <div style={{ color: "#6b7280", fontSize: 10 }}>{hasComparisonData ? `${entry.activeMembers} active` : noComparisonLabel}</div>
                        </div>
                        {!entry.hasData ? (<div style={{ color: "#6b7280", fontSize: 12, padding: "8px 0" }}>No JSON loaded for this club yet.</div>) : !hasComparisonData ? (<div style={{ color: "#6b7280", fontSize: 12, padding: "8px 0" }}>{noComparisonLabel}</div>) : entry.topFiveMembers.length === 0 ? (<div style={{ color: "#6b7280", fontSize: 12, padding: "8px 0" }}>No active members available.</div>) : (
                          <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                            <div style={{ display: "grid", gridTemplateColumns: "28px minmax(0, 1fr) auto auto", gap: 8, alignItems: "center", color: "#6b7280", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em" }}><div>#</div><div>Member</div><div>Day</div><div>Month</div></div>
                            {entry.topFiveMembers.map((member, index) => { const podiumStyle = getPodiumStyle(index); return (<div key={`${entry.clubName}-${member.name}-${index}`} style={{ display: "grid", gridTemplateColumns: "28px minmax(0, 1fr) auto auto", gap: 8, alignItems: "center" }}><div style={{ color: podiumStyle.color, textShadow: podiumStyle.textShadow, fontSize: 11, fontWeight: 800 }}>#{index + 1}</div><div style={{ color: podiumStyle.color, textShadow: podiumStyle.textShadow, fontWeight: 800, fontSize: 12, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{member.name}</div><div style={{ color: gainColor(member.dailyGain), fontWeight: 700, fontSize: 11 }}>{member.dailyGain != null ? fmtSigned(member.dailyGain) : "—"}</div><div style={{ color: gainColor(member.monthlyGain), fontWeight: 700, fontSize: 11 }}>{fmtSigned(member.monthlyGain ?? 0)}</div></div>); })}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>)}

              {rankingsTab === "clubs" && (<div id="network-critical-members" style={S.card}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center", flexWrap: "wrap", marginBottom: 8 }}><div style={S.h2}>Network Critical Members</div><div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}><button style={S.btn(criticalClubFilter === "all", "#7c3aed")} onClick={() => setCriticalClubFilter("all")}>All Clubs</button>{criticalClubOptions.map((cn) => (<button key={cn} style={S.btn(criticalClubFilter === cn, "#7c3aed")} onClick={() => setCriticalClubFilter(cn)}>{cn}</button>))}</div></div>
                <div style={{ color: "#6b7280", fontSize: 12, marginBottom: 12 }}>Members currently in critical status across all loaded clubs. All metrics reflect data through {dataDate.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}.</div>
                <div style={{ overflowX: "auto" }}><table style={{ width: "100%", borderCollapse: "collapse" }}><thead><tr style={{ textAlign: "left" }}><th style={S.th}>Member</th><th style={S.th}>Club</th><th style={{ ...S.th, cursor: "pointer" }} onClick={() => toggleCriticalSort("planDelta")}>Vs Weekly Plan {criticalSortLabel("planDelta")}</th><th style={{ ...S.th, cursor: "pointer" }} onClick={() => toggleCriticalSort("rolling3DayAvg")}>3-Day Avg {criticalSortLabel("rolling3DayAvg")}</th><th style={{ ...S.th, cursor: "pointer" }} onClick={() => toggleCriticalSort("projected")}>Projected Fans {criticalSortLabel("projected")}</th><th style={{ ...S.th, cursor: "pointer" }} onClick={() => toggleCriticalSort("fansNeeded")}>Needed for Month-End Plan {criticalSortLabel("fansNeeded")}</th><th style={S.th}>Idle</th></tr></thead><tbody>
                  {!hasComparisonData ? (<tr><td colSpan={7} style={{ ...S.td, textAlign: "center", color: "#6b7280", padding: "22px 8px" }}>{noComparisonLabel}</td></tr>) : criticalNetworkMembers.length === 0 ? (<tr><td colSpan={7} style={{ ...S.td, textAlign: "center", color: "#6b7280", padding: "22px 8px" }}>No members are currently in critical status across the selected clubs.</td></tr>) : (
                    visibleCriticalMembers.map((member, index) => (<tr key={`critical-${member.clubName}-${member.name}-${index}`}><td style={{ ...S.td, color: "#e2e0f0", fontWeight: 700 }}>{member.name}</td><td style={S.td}><div style={{ display: "flex", alignItems: "center", gap: 8 }}><TierBadge tier={member.clubTier} rankingConfig={viewRankingConfig} rankIconPath={viewRankIconPath} /><span>{member.clubName}</span></div></td><td style={{ ...S.td, color: STATUS_META["critical"].color, fontWeight: 700 }}>{deltaText(member.plan.delta)}</td><td style={{ ...S.td, color: criticalAvgColor(member.rolling3DayAvg ?? 0), fontWeight: 700 }}>{fmtSigned(member.rolling3DayAvg)}</td><td style={{ ...S.td, color: "#c4b5fd", fontWeight: 700 }}>{fmt(member.projected ?? 0)}</td><td style={{ ...S.td, color: "#e2e0f0", fontWeight: 700 }}>{fmt(member.fansNeededForPlan)}</td><td style={S.td}><StagnantBadge days={member.stagnantDays} /></td></tr>))
                  )}
                </tbody></table></div>
                {hasComparisonData && remainingCriticalCount > 0 && (<div style={{ position: "sticky", bottom: 0, paddingTop: 12, marginTop: -6, background: "linear-gradient(to bottom, rgba(10,9,18,0), rgba(10,9,18,0.96) 45%, rgba(10,9,18,1) 100%)", display: "flex", justifyContent: "center" }}><button style={S.btn(false, "#7c3aed")} onClick={() => setCriticalVisibleCount((prev) => prev + 10)}>Show {Math.min(10, remainingCriticalCount)} More</button></div>)}
              </div>)}
            </>)}

            {PAGE_MODE === "rankings" && (<>
              {rankingsTab === "clubs" && (<div id="club-health-scores" style={S.card}>
                <div style={S.h2}>Club Health Scores</div>
                <div style={{ color: "#6b7280", fontSize: 12, marginBottom: 14 }}>Composite score: % on track (40%) + projected vs target (35%) + member activity (25%).</div>
                {!hasComparisonData ? (<div style={{ background: "rgba(11,9,24,0.72)", border: "1px solid #1e1b35", borderRadius: 12, padding: "14px 16px", color: "#6b7280", fontSize: 12 }}>{noComparisonLabel}</div>) : (
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 10 }}>
                    {networkClubs.filter((e) => e.hasData).sort((a, b) => b.health.score - a.health.score).map((entry) => (
                      <div key={`hs-${entry.name}`} style={{ background: "rgba(11,9,24,0.72)", border: `1px solid ${entry.health.color}44`, borderRadius: 12, padding: "14px" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10, marginBottom: 10 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                            <TierBadge tier={entry.tier} rankingConfig={viewRankingConfig} rankIconPath={viewRankIconPath} />
                            <div>
                              <div style={{ color: "#e2e0f0", fontWeight: 800, fontSize: 14 }}>{entry.clubName}</div>
                              <div style={{ color: "#6b7280", fontSize: 10, marginTop: 2 }}>{entry.activeMembers} members · {entry.health.score}/100 composite</div>
                            </div>
                          </div>
                          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6, flexShrink: 0 }}>
                            <HealthBadge grade={entry.health.grade} />
                            <span style={{ color: entry.health.color, fontSize: 11, fontWeight: 800 }}>{entry.health.score}%</span>
                          </div>
                        </div>
                        <div style={{ marginBottom: 10 }}><ProgressBar pct={entry.health.score} color={entry.health.color} height={7} /></div>
                        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 8, marginBottom: 10, fontSize: 11 }}>
                          <div style={{ background: "#0c0b18", border: "1px solid #1e1b35", borderRadius: 10, padding: "10px" }}><div style={{ color: "#4b5563", fontSize: 9, textTransform: "uppercase", marginBottom: 3 }}>On-track members</div><div style={{ color: "#34d399", fontWeight: 800 }}>{entry.statusCounts["on-track"]}/{entry.activeMembers}</div></div>
                          <div style={{ background: "#0c0b18", border: "1px solid #1e1b35", borderRadius: 10, padding: "10px" }}><div style={{ color: "#4b5563", fontSize: 9, textTransform: "uppercase", marginBottom: 3 }}>Projected monthly</div><div style={{ color: "#c4b5fd", fontWeight: 800 }}>{fmt(entry.totalProjected)}</div></div>
                        </div>
                        <div style={{ display: "grid", gap: 8 }}>
                          <HealthScoreComponent
                            label="On-track members"
                            ratio={entry.health.components.onTrack.ratio}
                            weight={entry.health.components.onTrack.weight}
                            accent={entry.health.components.onTrack.accent}
                            helper={`${entry.statusCounts["on-track"]}/${entry.activeMembers} members currently on pace`}
                          />
                          <HealthScoreComponent
                            label="Projected vs target"
                            ratio={entry.health.components.projected.ratio}
                            weight={entry.health.components.projected.weight}
                            accent={entry.health.components.projected.accent}
                            helper={`${fmt(entry.totalProjected)} projected against ${fmt(entry.clubTarget)} target`}
                          />
                          <HealthScoreComponent
                            label="Member activity"
                            ratio={entry.health.components.activity.ratio}
                            weight={entry.health.components.activity.weight}
                            accent={entry.health.components.activity.accent}
                            helper={`${entry.nonStagnantMembers}/${entry.activeMembers} members with fewer than 3 idle days`}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>)}
              {rankingsTab === "home" && (<>
              <div id="network-pace-chart" style={S.card}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 8 }}><div><div style={S.h2}>Network Pace Chart — Club Progress vs Target (%)</div><div style={{ color: "#6b7280", fontSize: 12, marginTop: 4 }}>Each club's aggregate monthly gain as % of their total target. Dashed line = ideal pace. Hover a day to see each club's fan gain totals and % of target.</div></div><div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}><button style={S.btn(networkChartMode === "cumulative", networkChartMode === "cumulative" ? "#7c3aed" : undefined)} onClick={() => setNetworkChartMode("cumulative")}>Cumulative</button><button style={S.btn(networkChartMode === "daily", networkChartMode === "daily" ? "#7c3aed" : undefined)} onClick={() => setNetworkChartMode("daily")}>Daily Gain</button></div></div>
                <NetworkPaceChart clubs={networkClubs.filter((e) => e.hasData)} dim={dim} today={today} mode={networkChartMode} currentDayIdx={Math.max(0, today - 1)} />
              </div>
              <div id="club-rank-history" style={S.card}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
                  <div>
                    <div style={S.h2}>Club Rank History</div>
                    <div style={{ color: "#6b7280", fontSize: 12, marginTop: 4 }}>Daily monthly_rank for each club. Lower rank = better. Tier icons mark boundaries on the y-axis.</div>
                  </div>
                </div>
                <NetworkRankChart clubs={networkClubs} dim={dim} effectiveGameDayKey={effectiveGameDayKey} rankHistory={rankHistory} rankingConfig={viewRankingConfig} rankIconPath={viewRankIconPath} />
              </div>
              </>)}
            </>)}

            {PAGE_MODE === "archives" && (
              window.DeeperInsightsPage
                ? <window.DeeperInsightsPage
                    clubs={viewClubs}
                    clubData={clubData}
                    archiveManifest={archiveManifest}
                    today={today}
                    dim={dim}
                    monthKey={formatDateKey(year, monthIndex + 1, 1).slice(0, 7)}
                    archiveMonth={archiveMonth}
                    isArchiveView={isArchiveView}
                  />
                : <div style={{ ...S.card, minHeight: 300, display: "flex", alignItems: "center", justifyContent: "center", color: "#f87171" }}>Deeper Insights failed to load. Refresh the page and check the browser console.</div>
            )}
          </>)}

          {view === "club" && !cid && (<div style={{ ...S.card, textAlign: "center", padding: "50px 20px" }}><div style={{ fontSize: 40, marginBottom: 10 }}>🔜</div><div style={{ color: "#6b7280" }}><b style={{ color: "#9ca3af" }}>{club.name}</b> is a future addition.</div></div>)}

          {view === "club" && cid && (<>
            <div className="club-banner" style={{ ...S.card, background: tc.bg, border: `1px solid ${tc.border}`, padding: "14px 18px", "--tier-c": tc.border }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8, position: "relative" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <span className="gate-plate">{String(activeIdx + 1).padStart(2, "0")}</span>
                  <TierBadge tier={club.tier} rankingConfig={viewRankingConfig} rankIconPath={viewRankIconPath} />
                  <div>
                    <div style={{ fontSize: 20, fontWeight: 800, color: "#e2e0f0", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                      {clubName}
                      {(() => { const ri = getClubRankInfo(cid); return ri.rank != null ? <MonthlyRankBadge rank={ri.rank} delta={ri.delta} rankingConfig={viewRankingConfig} rankIconPath={viewRankIconPath} /> : null; })()}
                    </div>
                    <div style={{ fontSize: 11, color: "#9ca3af" }}>Officer: {club.officer} · ID: {club.id || "TBD"} · Max {viewMaxMembers} members</div>
                  </div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: tc.text }}>{fmt(club.target)} / member / month</div>
                  <div style={{ fontSize: 10, color: "#6b7280", marginTop: 2 }}>Week {currentWeek?.number || 1} · {getWeekLabel(currentWeek, year, monthIndex)}</div>
                  {displayFetch && <div style={{ fontSize: 10, color: "#6b7280", marginTop: 2 }}>{displayFetchLabel} {new Date(displayFetch).toLocaleString()}</div>}
                </div>
              </div>
            </div>

            {!decoratedMembers.length ? (<div style={{ ...S.card, textAlign: "center", padding: "50px 20px" }}><div style={{ fontSize: 44, marginBottom: 10 }}>🏇</div><div style={{ color: "#6b7280", marginBottom: 16 }}>No active member data for <b style={{ color: "#9ca3af" }}>{clubName}</b> yet.</div><div style={{ display: "flex", justifyContent: "center", gap: 8 }}><button style={S.btn(false, tc.bar)} onClick={() => fetchData()}>🔄 Refresh Data</button></div></div>) : (<>
              <div className="tab-dock">
                {[["dashboard", "📊 Overview"], ["members", "👥 Members"], ["pace", "📈 Pace"]].map(([tabKey, label]) => (<button key={tabKey} style={S.btn(tab === tabKey, tab === tabKey ? tc.bar : undefined)} onClick={() => setTab(tabKey)}>{label}</button>))}
              </div>

              {tab === "dashboard" && (<>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 10, marginBottom: 14 }}>
                  {[
                    { label: "Active Members", value: hasComparisonData ? `${decoratedMembers.length}/${viewMaxMembers}` : "—", sub: hasComparisonData ? "Inactive excluded" : noComparisonLabel, col: hasComparisonData ? "#e2e0f0" : "#9ca3af" },
                    { label: `${STATUS_META["on-track"].icon} ${STATUS_META["on-track"].label}`, value: hasComparisonData ? statusCounts["on-track"] : "—", sub: hasComparisonData ? "At or above weekly pace" : noComparisonLabel, col: "#34d399", filterKey: hasComparisonData ? "on-track" : null },
                    { label: `${STATUS_META["behind"].icon} ${STATUS_META["behind"].label}`, value: hasComparisonData ? statusCounts["behind"] : "—", sub: hasComparisonData ? "Below pace but above 25%" : noComparisonLabel, col: "#fbbf24", filterKey: hasComparisonData ? "behind" : null },
                    { label: `${STATUS_META["critical"].icon} ${STATUS_META["critical"].label}`, value: hasComparisonData ? statusCounts["critical"] : "—", sub: hasComparisonData ? "Under 25% of weekly pace" : noComparisonLabel, col: "#f87171", filterKey: hasComparisonData ? "critical" : null },
                    { label: "Club Monthly +", value: hasComparisonData ? fmt(totalMonthly) : "—", sub: hasComparisonData ? "All active members" : noComparisonLabel, col: hasComparisonData ? gainColor(totalMonthly) : "#9ca3af" },
                    { label: "Club Daily +", value: totalDaily != null ? fmt(totalDaily) : "—", sub: `Current Day ${today} total fan gain`, col: "#cfcbe6" },
                    { label: "Previous Day +", value: totalPreviousDaily != null ? fmt(totalPreviousDaily) : "—", sub: today > 1 ? `Day ${today - 1} total fan gain` : "No previous day in this month", col: "#c4b5fd" },
                    { label: "Club Vs Weekly Plan", value: hasComparisonData ? fmtSigned(clubWeeklyDelta) : "—", sub: hasComparisonData ? `Target by displayed day: ${fmt(clubExpectedToDate)}` : noComparisonLabel, col: hasComparisonData ? gainColor(clubWeeklyDelta) : "#9ca3af" },
                  ].map((card) => { const isFilterCard = Boolean(card.filterKey); const isActive = overviewStatusFilter === card.filterKey; const sharedStyle = { background: "#111028", border: `1px solid ${isActive ? card.col : "#1e1b35"}`, borderRadius: 12, padding: "11px 14px", boxShadow: isActive ? `0 0 0 1px ${card.col}33 inset` : "none" }; return isFilterCard ? (<button key={card.label} onClick={() => toggleOverviewStatusFilter(card.filterKey)} style={{ ...sharedStyle, textAlign: "left", cursor: "pointer" }}><div style={{ color: "#4b5563", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 3 }}>{card.label}</div><div style={{ color: card.col, fontSize: 18, fontWeight: 700 }}>{card.value}</div><div style={{ color: isActive ? card.col : "#4b5563", fontSize: 10, marginTop: 2 }}>{isActive ? "Showing only this status" : card.sub}</div></button>) : (<div key={card.label} style={sharedStyle}><div style={{ color: "#4b5563", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 3 }}>{card.label}</div><div style={{ color: card.col, fontSize: 18, fontWeight: 700 }}>{card.value}</div><div style={{ color: "#4b5563", fontSize: 10, marginTop: 2 }}>{card.sub}</div></div>); })}
                </div>

                <div style={S.card}>
                  <div style={S.h2}>Member Progress — Sorted by Monthly Gain</div>
                  {overviewStatusFilter && (<div style={{ color: STATUS_META[overviewStatusFilter]?.color || "#9ca3af", fontSize: 12, marginBottom: 10 }}>Filtering overview to {STATUS_META[overviewStatusFilter]?.icon} {STATUS_META[overviewStatusFilter]?.label}. Click the same summary card again to clear.</div>)}
                  {!hasComparisonData && (<div style={{ color: "#6b7280", fontSize: 12, marginBottom: 10 }}>{noComparisonLabel}</div>)}
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {overviewMembers.length === 0 && (<div style={{ background: "rgba(11,9,24,0.72)", border: "1px solid #1e1b35", borderRadius: 10, padding: "14px 16px", color: "#6b7280", fontSize: 12 }}>No members match the current overview filter.</div>)}
                    {overviewMembers.map((member, index) => { const monthPct = club.target > 0 ? Math.min(100, ((member.monthlyGain ?? 0) / club.target) * 100) : 0; const stillNeed = Math.max(0, club.target - (member.monthlyGain ?? 0)); const statusMeta = getDisplayStatusMeta(member.plan.statusKey); const progressColor = statusMeta.color; return (
                      <div key={`${member.name}-${index}`} style={{ background: "rgba(11,9,24,0.72)", border: "1px solid #1e1b35", borderRadius: 10, padding: "12px 14px" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 7, flexWrap: "wrap", gap: 4 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 8 }}><span style={{ color: "#4b5563", fontSize: 11, fontWeight: 700, minWidth: 20 }}>#{index + 1}</span><span style={{ fontWeight: 700, color: "#e2e0f0", fontSize: 13 }}>{member.name}</span><StatusBadge statusKey={getDisplayStatusKey(member.plan.statusKey)} /><StagnantBadge days={member.stagnantDays} /></div>
                          <div style={{ display: "flex", gap: 14, fontSize: 11, flexWrap: "wrap" }}><span style={{ color: "#6b7280" }}>Today: <b style={{ color: gainColor(member.dailyGain) }}>{member.dailyGain != null ? fmtSigned(member.dailyGain) : "—"}</b></span><span style={{ color: "#6b7280" }}>Month: <b style={{ color: gainColor(member.monthlyGain) }}>{member.monthlyGain != null ? fmtSigned(member.monthlyGain) : "—"}</b></span><span style={{ color: "#6b7280" }}>Projected: <b style={{ color: "#c4b5fd" }}>{member.projected != null ? fmt(member.projected) : "—"}</b></span><span style={{ color: "#6b7280" }}>ETA: <b><DaysToTargetBadge days={member.daysToTarget} daysLeft={daysLeft} /></b></span></div>
                        </div>
                        <div style={{ marginBottom: 8 }}><ProgressBar pct={monthPct} color={progressColor} height={9} /></div>
                        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 10, alignItems: "center" }}>
                          <div><div style={{ color: "#4b5563", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em" }}>Current Fans</div><div style={{ color: "#e2e0f0", fontWeight: 700, fontSize: 14 }}>{fmtFull(member.fans)}</div></div>
                          <div><div style={{ color: "#4b5563", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em" }}>Target Progress</div><div style={{ color: progressColor, fontWeight: 700, fontSize: 14 }}>{monthPct.toFixed(1)}%</div></div>
                          <div><div style={{ color: "#4b5563", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em" }}>Still Needed</div><div style={{ color: "#e2e0f0", fontWeight: 700, fontSize: 14 }}>{fmt(stillNeed)}</div></div>
                          <div><div style={{ color: "#4b5563", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em" }}>Vs Weekly Plan</div><div style={{ color: progressColor, fontWeight: 700, fontSize: 14 }}>{displayPlanDeltaText(member.plan.delta)}</div></div>
                          <div style={{ justifySelf: "end" }}><Sparkline data={member.cumulativeSeries || member.dailyFans || []} visibleDayCount={today} color={statusMeta.color} /></div>
                        </div>
                      </div>
                    ); })}
                  </div>
                </div>
              </>)}

              {tab === "members" && (
                <div style={S.card}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 10 }}><div><div style={S.h2}>Members</div><div style={{ color: "#6b7280", fontSize: 12 }}>Name and Status use dropdown filters. Fans, Today, Month, and Projected cycle through Desc, Asc, and Off sorting.</div></div><button style={S.btn(false)} onClick={clearMemberFilters}>Clear filters</button></div>
                  <div style={{ overflowX: "auto" }}><table style={{ width: "100%", borderCollapse: "collapse" }}><thead><tr style={{ textAlign: "left" }}>
                    {[{ key: "rank", label: "#", sortable: false }, { key: "name", label: "Name", sortable: false }, { key: "fans", label: "Fans", sortable: true }, { key: "dailyGain", label: "Today", sortable: true }, { key: "monthlyGain", label: "Month", sortable: true }, { key: "projected", label: "Projected", sortable: true }, { key: "weeklyDelta", label: "Vs Weekly Plan", sortable: false }, { key: "daysToTarget", label: "ETA", sortable: true }, { key: "stagnantDays", label: "Idle", sortable: true }, { key: "status", label: "Status", sortable: false }].map((col) => (<th key={col.key} style={S.th}>{col.sortable ? (<button style={{ background: "transparent", border: "none", color: "inherit", font: "inherit", cursor: "pointer", padding: 0, display: "inline-flex", gap: 6, alignItems: "center" }} onClick={() => handleSort(col.key)}><span>{col.label}</span><span style={{ color: memberSort.key === col.key ? tc.text : "#4b5563", fontSize: 10 }}>{sortIndicator(col.key)}</span></button>) : (<span>{col.label}</span>)}</th>))}
                  </tr><tr><th style={S.th}></th><th style={S.th}><select style={S.input} value={memberFilters.name} onChange={(e) => updateMemberFilter("name", e.target.value)}><option value="">All Members</option>{memberNameOptions.map((name) => (<option key={name} value={name}>{name}</option>))}</select></th><th style={S.th}></th><th style={S.th}></th><th style={S.th}></th><th style={S.th}></th><th style={S.th}></th><th style={S.th}></th><th style={S.th}></th><th style={S.th}><select style={S.input} value={memberFilters.status} onChange={(e) => updateMemberFilter("status", e.target.value)}><option value="">All Statuses</option>{hasComparisonData ? (<><option value="on-track">On Track</option><option value="behind">Behind</option><option value="critical">Critical</option></>) : (<option value={DAY1_STATUS_KEY}>N/A - Day 1</option>)}</select></th></tr></thead><tbody>
                    {memberRows.length === 0 ? (<tr><td colSpan={10} style={{ ...S.td, color: "#6b7280", textAlign: "center", padding: "22px 8px" }}>No members match the current filters.</td></tr>) : (
                      memberRows.map(({ member, rank }) => (<tr key={`${member.name}-${rank}`}><td style={{ ...S.td, color: "#6b7280" }}>{rank}</td><td style={{ ...S.td, color: "#e2e0f0", fontWeight: 700 }}>{member.name}</td><td style={S.td}>{fmtFull(member.fans)}</td><td style={{ ...S.td, color: gainColor(member.dailyGain) }}>{member.dailyGain != null ? fmtSigned(member.dailyGain) : "—"}</td><td style={{ ...S.td, color: gainColor(member.monthlyGain) }}>{member.monthlyGain != null ? fmtSigned(member.monthlyGain) : "—"}</td><td style={{ ...S.td, color: "#c4b5fd" }}>{member.projected != null ? fmt(member.projected) : "—"}</td><td style={{ ...S.td, color: hasComparisonData ? (STATUS_META[member.plan.statusKey]?.color || gainColor(member.plan.delta)) : "#9ca3af", fontWeight: 700 }}>{displayPlanDeltaText(member.plan.delta)}</td><td style={S.td}><DaysToTargetBadge days={member.daysToTarget} daysLeft={daysLeft} /></td><td style={S.td}><StagnantBadge days={member.stagnantDays} /></td><td style={S.td}><StatusBadge statusKey={getDisplayStatusKey(member.plan.statusKey)} /></td></tr>))
                    )}
                  </tbody></table></div>
                </div>
              )}

              {tab === "pace" && (
                <div style={S.card}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}><div><div style={S.h2}>Member Pace</div><div style={{ color: "#6b7280", fontSize: 12 }}>Toggle between cumulative progress and daily gain. The chart only draws through the displayed data day, and inactive members are fully excluded.</div></div><div style={{ color: "#9ca3af", fontSize: 12 }}>{getWeekLabel(currentWeek, year, monthIndex)}</div></div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 10, marginBottom: 14 }}>
                    {[{ label: "Current Week", value: `Week ${currentWeek?.number || 1}`, sub: getWeekLabel(currentWeek, year, monthIndex), col: "#e2e0f0" }, { label: "Per-Member Target by Displayed Day", value: hasComparisonData ? fmt(decoratedMembers[0]?.plan.expectedToDate ?? 0) : "—", sub: hasComparisonData ? `${fmt(club.target)} monthly quota` : noComparisonLabel, col: hasComparisonData ? "#c4b5fd" : "#9ca3af" }, { label: "Current Week Target", value: fmt(decoratedMembers[0]?.plan.currentWeekTarget ?? 0), sub: getWeekLabel(currentWeek, year, monthIndex), col: "#34d399" }, { label: "Visible on Graph", value: `${paceSeriesList.length}/${allPaceSeriesList.length}`, sub: hasComparisonData ? `${statusCounts["on-track"]} on track · ${statusCounts["critical"]} critical` : noComparisonLabel, col: "#e2e0f0" }].map((card) => (<div key={card.label} style={{ background: "rgba(11,9,24,0.72)", border: "1px solid #1e1b35", borderRadius: 12, padding: "11px 14px" }}><div style={{ color: "#4b5563", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 3 }}>{card.label}</div><div style={{ color: card.col, fontSize: 18, fontWeight: 700 }}>{card.value}</div><div style={{ color: "#4b5563", fontSize: 10, marginTop: 2 }}>{card.sub}</div></div>))}
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 10 }}>
                    <div style={{ color: "#9ca3af", fontSize: 12 }}>Click on the graph to pin a tooltip, then export to include it in the image.{" "}{pacePinnedIdx != null && (<span style={{ color: "#a78bfa", fontWeight: 700 }}>📌 Tooltip pinned — export will capture it.</span>)}</div>
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}><button style={S.btn(paceChartMode === "cumulative", "#7c3aed")} onClick={() => setPaceChartMode("cumulative")}>Cumulative</button><button style={S.btn(paceChartMode === "daily", "#2563eb")} onClick={() => setPaceChartMode("daily")}>Daily Gain</button><button style={S.btn(false)} onClick={() => setPaceZoom((prev) => Math.max(1, +(prev - 0.25).toFixed(2)))}>− Zoom</button><button style={S.btn(false)} onClick={() => setPaceZoom(1)}>Reset</button><button style={S.btn(false)} onClick={() => setPaceZoom((prev) => Math.min(3, +(prev + 0.25).toFixed(2)))}>+ Zoom</button>{pacePinnedIdx != null && (<button style={S.btn(false, "#a78bfa")} onClick={() => setPacePinnedIdx(null)}>📌 Unpin Tooltip</button>)}<button style={S.btn(false)} onClick={exportPaceGraph}>{paceExporting ? "⟳ Exporting…" : "🖼️ Export Graph"}</button></div>
                  </div>
{supportsMemberDailyFans ? <PaceChart seriesList={paceSeriesList} targetSeries={selectedPaceTargetSeries} weeks={monthWeeks} year={year} monthIndex={monthIndex} svgRef={paceSvgRef} zoom={paceZoom} pinnedIdx={pacePinnedIdx} setPinnedIdx={setPacePinnedIdx} containerRef={paceContainerRef} currentDayIdx={Math.max(0, today - 1)} mode={paceChartMode} /> : <div style={{ color: "#6b7280", fontSize: 12, padding: "18px 0" }}>This source does not expose enough per-member daily history to render the pace chart.</div>}
                  <div style={{ marginTop: 16, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 10 }}>
                    {monthWeeks.map((week) => { const isFutureWeek = week.startDay > today; const measuredEndDay = Math.min(week.endDay, today); const elapsedDayCount = Math.max(0, measuredEndDay - week.startDay + 1); const fullWeekTarget = Math.round((club.target / Math.max(dim, 1)) * week.dayCount); const elapsedWeekTarget = Math.round((club.target / Math.max(dim, 1)) * elapsedDayCount); const checkpointTarget = week.endDay <= today ? fullWeekTarget : elapsedWeekTarget; const currentValues = isFutureWeek ? [] : allPaceSeriesList.map((item) => (item.dailySeries || []).slice(Math.max(0, week.startDay - 1), Math.max(0, measuredEndDay)).reduce((sum, value) => sum + (value || 0), 0)).sort((a, b) => b - a); const medianValue = currentValues.length ? currentValues[Math.floor(currentValues.length / 2)] : null; const medianDelta = medianValue == null ? null : medianValue - checkpointTarget; const onPaceAtCheckpoint = currentValues.filter((value) => value >= checkpointTarget).length; return (<div key={week.number} style={{ background: "rgba(11,9,24,0.72)", border: "1px solid #1e1b35", borderRadius: 12, padding: "12px 13px" }}><div style={{ color: "#e2e0f0", fontWeight: 700, fontSize: 13, marginBottom: 4 }}>Week {week.number}</div><div style={{ color: "#6b7280", fontSize: 11, marginBottom: 8 }}>{getWeekLabel(week, year, monthIndex)}</div><div style={{ color: "#6b7280", fontSize: 11 }}>Per-member weekly target: <b style={{ color: "#c4b5fd" }}>{fmt(week.endDay <= today ? fullWeekTarget : checkpointTarget)}</b></div>{!isFutureWeek && (<div style={{ color: "#6b7280", fontSize: 11 }}>Median member weekly actual: <b style={{ color: "#fbbf24" }}>{fmt(medianValue)}</b>{" "}<span style={{ color: gainColor(medianDelta), fontWeight: 700 }}>({fmtSigned(medianDelta)})</span></div>)}<div style={{ color: "#9ca3af", fontSize: 11, fontWeight: 700, marginTop: 5 }}>{isFutureWeek ? "Not started yet" : `${onPaceAtCheckpoint}/${allPaceSeriesList.length} on pace for the week`}</div></div>); })}
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap", alignItems: "center", marginTop: 16, marginBottom: 10 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}><div style={{ color: "#9ca3af", fontSize: 12 }}>Click cards to toggle visibility.</div><button style={S.btn(false)} onClick={() => setPaceCardsCollapsed((p) => !p)}>{paceCardsCollapsed ? "▼ Expand Cards" : "▲ Collapse Cards"}</button></div>
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}><button style={S.btn(false)} onClick={showAllPaceMembers}>Show All</button><button style={S.btn(false)} onClick={hideAllPaceMembers}>Hide All</button><button style={S.btn(false, STATUS_META["on-track"].color)} onClick={() => showOnlyPaceStatus("on-track")}>{STATUS_META["on-track"].icon} On Track Only</button><button style={S.btn(false, STATUS_META["behind"].color)} onClick={() => showOnlyPaceStatus("behind")}>{STATUS_META["behind"].icon} Behind Only</button><button style={S.btn(false, STATUS_META["critical"].color)} onClick={() => showOnlyPaceStatus("critical")}>{STATUS_META["critical"].icon} Critical Only</button></div>
                  </div>
                  {paceCardsCollapsed ? (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                      {sortedByMonthly.map((member, index) => { const isHidden = Boolean(paceHiddenMembers[member.name]); const lineColor = allPaceSeriesList.find((s) => s.name === member.name)?.color || getLineColor(index); const sm = STATUS_META[member.plan.statusKey] || STATUS_META["behind"]; return (<button key={`chip-${member.name}`} onClick={() => togglePaceMember(member.name)} style={{ background: isHidden ? "#0a0912" : "#0f0d1a", border: `1px solid ${isHidden ? "#1e1b35" : sm.border}`, borderRadius: 8, padding: "5px 10px", cursor: "pointer", opacity: isHidden ? 0.5 : 1, display: "flex", alignItems: "center", gap: 6, fontSize: 11 }}><span style={{ width: 8, height: 8, borderRadius: 999, background: lineColor, flexShrink: 0 }} /><span style={{ color: "#e2e0f0", fontWeight: 700 }}>{member.name}</span><span style={{ color: sm.color, fontSize: 10 }}>{fmtSigned(member.monthlyGain ?? 0)}</span>{member.stagnantDays >= 2 && <span style={{ color: "#f97316", fontSize: 9 }}>⏸{member.stagnantDays}d</span>}</button>); })}
                    </div>
                  ) : (
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: 10 }}>
                      {sortedByMonthly.map((member, index) => { const statusMeta = STATUS_META[member.plan.statusKey] || STATUS_META["behind"]; const isHidden = Boolean(paceHiddenMembers[member.name]); const lineColor = allPaceSeriesList.find((item) => item.name === member.name)?.color || getLineColor(index); return (
                        <button key={`pace-card-${member.name}`} onClick={() => togglePaceMember(member.name)} style={{ background: isHidden ? "#0a0912" : "#0f0d1a", border: `1px solid ${isHidden ? "#1e1b35" : statusMeta.border}`, borderRadius: 12, padding: "12px 13px", textAlign: "left", cursor: "pointer", opacity: isHidden ? 0.55 : 1, boxShadow: isHidden ? "none" : `0 0 0 1px ${statusMeta.bg} inset` }}>
                          <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center", marginBottom: 8 }}><div style={{ minWidth: 0 }}><div style={{ color: "#e2e0f0", fontWeight: 800, fontSize: 13, display: "flex", alignItems: "center", gap: 7 }}><span style={{ width: 10, height: 10, borderRadius: 999, background: lineColor, display: "inline-block", flexShrink: 0 }} /><span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{member.name}</span></div><div style={{ color: "#6b7280", fontSize: 11, marginTop: 3, display: "flex", alignItems: "center", gap: 6 }}>{isHidden ? "Hidden" : "Showing"} <StagnantBadge days={member.stagnantDays} /></div></div><StatusBadge statusKey={getDisplayStatusKey(member.plan.statusKey)} /></div>
                          <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 8 }}>
                            <div><div style={{ color: "#4b5563", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em" }}>Total Fans</div><div style={{ color: "#e2e0f0", fontWeight: 700, fontSize: 14 }}>{fmtFull(member.fans)}</div></div>
                            <div><div style={{ color: "#4b5563", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em" }}>Monthly Gain</div><div style={{ color: statusMeta.color, fontWeight: 700, fontSize: 14 }}>{fmtSigned(member.monthlyGain ?? 0)}</div></div>
                            <div><div style={{ color: "#4b5563", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em" }}>ETA to Target</div><div style={{ color: statusMeta.color, fontWeight: 700, fontSize: 14 }}><DaysToTargetBadge days={member.daysToTarget} daysLeft={daysLeft} /></div></div>
                            <div><div style={{ color: "#4b5563", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em" }}>Vs Weekly Plan</div><div style={{ color: statusMeta.color, fontWeight: 700, fontSize: 14 }}>{deltaText(member.plan.delta)}</div></div>
                          </div>
                        </button>
                      ); })}
                    </div>
                  )}
                </div>
              )}

              {tab === "debug" && (
                <div style={S.card}>
                  <div style={S.h2}>Debug</div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}><button style={S.btn(false)} onClick={() => fetchData()}>Reload current club</button><button style={S.btn(false)} onClick={() => loadAllData()}>Reload all clubs</button><button style={S.btn(false)} onClick={() => setDebugLog([])}>Clear log</button></div>
                  <div style={{ color: "#9ca3af", fontSize: 12, marginBottom: 12, lineHeight: 1.7 }}>This page reads JSON from your deployed repo files. Expected path for this club: <b style={{ color: "#e2e0f0" }}>`data/chronogenesis/${cid}.json`</b></div>
                  <pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", background: "#0a0912", border: "1px solid #1e1b35", borderRadius: 10, padding: 12, color: "#c4b5fd", fontSize: 12, lineHeight: 1.55 }}>{debugLog.length ? debugLog.join("\n") : "No debug entries yet."}</pre>
                </div>
              )}
            </>)}
          </>)}
            </main>
          </div>

          {/* ── Mobile dock ── */}
          <div className="mobile-dock">
            <a href="./index.html" style={{ ...S.btn(PAGE_MODE === "home", "#7c3aed"), flex: 1, textDecoration: "none", textAlign: "center" }}>🏠 Home</a>
            <a href="./clubs.html" style={{ ...S.btn(PAGE_MODE === "clubs", "#7c3aed"), flex: 1, textDecoration: "none", textAlign: "center" }}>📋 Clubs</a>
            <a href="./rankings.html" style={{ ...S.btn(PAGE_MODE === "rankings", "#2563eb"), flex: 1, textDecoration: "none", textAlign: "center" }}>🌐 Ranks</a>
            <a href={clubDetailHref} style={{ ...S.btn(PAGE_MODE === "club", tc.bar), flex: 1, textDecoration: "none", textAlign: "center" }}>🏇 Detail</a>
            <a href={insightsHref} style={{ ...S.btn(PAGE_MODE === "archives", "#a78bfa"), flex: 1, textDecoration: "none", textAlign: "center" }}>🔎 Insights</a>
          </div>
        </div>
      );
    }

    async function startApp() {
      const { clubs } = await loadFrontendConfig();
      CURRENT_CLUBS = clubs;
      ReactDOM.createRoot(document.getElementById("root")).render(<AppErrorBoundary><CircleTracker /></AppErrorBoundary>);
    }

    if (window.__ALLOW_APP__) {
      startApp().catch((error) => {
        console.error(error);
        const root = document.getElementById("root");
        if (root) {
          root.innerHTML = `<div style="max-width:760px;margin:48px auto;padding:24px;border:1px solid #7f1d1d;border-radius:16px;background:#220b18;color:#fca5a5;font-family:Inter,system-ui,sans-serif"><h1 style="font-size:20px;margin-bottom:10px">Tracker configuration failed to load</h1><p style="line-height:1.6">${String(error.message || error)}</p></div>`;
        }
      });
    }
