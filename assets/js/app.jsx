const { useState, useEffect, useRef } = React;

    const DATA_SOURCE = "chronogenesis";
    const FRONTEND_CONFIG_PATHS = ["./config/frontend.json", "/config/frontend.json"];
    const RANK_THRESHOLD_DATA_PATHS = ["./data/rank-thresholds.json", "/data/rank-thresholds.json"];
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
              color: "#f3e9ee",
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
    const gainColor = (n) => n == null ? "#ae9aa5" : n > 0 ? "#34d399" : n < 0 ? "#f87171" : "#9ca3af";

    function finiteThresholdNumber(value) {
      if (value == null || value === "") return null;
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    }

    function getMedian(values) {
      const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
      if (!sorted.length) return 0;
      const middle = Math.floor(sorted.length / 2);
      return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
    }

    function getThresholdForecastWeight(day, monthLength) {
      const progress = Math.max(0, Math.min(1, Number(day || 1) / Math.max(1, Number(monthLength || 1))));
      if (progress <= 0.25) return 0.75;
      if (progress <= 0.50) return 0.85;
      if (progress <= 0.75) return 0.92;
      return 0.97;
    }

    function buildRankThresholdForecast(feed, expectedMonth, displayedDay, monthLength) {
      const base = {
        status: "missing",
        ready: false,
        observationCount: 0,
        rows: [],
        message: "The daily UMA threshold feed has not created data/rank-thresholds.json yet.",
      };
      if (!feed || typeof feed !== "object") return base;
      if (feed.month !== expectedMonth) {
        return { ...base, status: "month-mismatch", message: "The available threshold feed is for " + (feed.month || "an unknown month") + ", not " + expectedMonth + "." };
      }

      const availableSnapshots = (Array.isArray(feed.days) ? feed.days : [])
        .filter((snapshot) =>
          snapshot &&
          Number.isFinite(Number(snapshot.day)) &&
          Number(snapshot.day) <= displayedDay &&
          Array.isArray(snapshot.thresholds)
        )
        .sort((a, b) => Number(a.day) - Number(b.day));
      const displaySnapshot = availableSnapshots[availableSnapshots.length - 1] || (
        Number(feed?.latest?.day) <= displayedDay && Array.isArray(feed?.latest?.thresholds)
          ? feed.latest
          : null
      );
      const latestThresholds = Array.isArray(displaySnapshot?.thresholds) ? displaySnapshot.thresholds : [];
      const actualRows = latestThresholds
        .map((threshold) => ({
          ...threshold,
          rank_index: finiteThresholdNumber(threshold?.rank_index),
          ranking_from: finiteThresholdNumber(threshold?.ranking_from),
          ranking_to: finiteThresholdNumber(threshold?.ranking_to),
          current_min_fans: finiteThresholdNumber(threshold?.current_min_fans),
          daily_fans_delta: finiteThresholdNumber(threshold?.daily_fans_delta),
          last_month_min_fans: finiteThresholdNumber(threshold?.last_month_min_fans),
          current_vs_last_month_delta: finiteThresholdNumber(threshold?.current_vs_last_month_delta),
        }))
        .filter((threshold) => threshold.rank_index != null && threshold.name)
        .sort((a, b) => b.rank_index - a.rank_index);

      if (!actualRows.length) {
        return { ...base, status: "invalid", message: "The threshold file loaded, but its latest snapshot did not contain usable ranks." };
      }

      const activationDay = finiteThresholdNumber(feed.activationDay);
      const observations = availableSnapshots
        .filter((snapshot) =>
          (!activationDay || Number(snapshot.day) >= activationDay) &&
          Array.isArray(snapshot.thresholds)
        )
        .sort((a, b) => Number(a.day) - Number(b.day));
      const observationCount = observations.length;
      const currentMonthActive = feed.currentMonthActive === true && (!activationDay || activationDay <= displayedDay);
      const ready = currentMonthActive && observationCount >= 3;
      const currentWeight = getThresholdForecastWeight(displayedDay, monthLength);

      const rows = actualRows.map((row) => {
        let projectedMinFans = null;
        if (ready && row.current_min_fans != null) {
          const series = observations
            .map((snapshot) => {
              const match = snapshot.thresholds.find((threshold) => String(threshold?.name) === String(row.name));
              return { day: Number(snapshot.day), value: finiteThresholdNumber(match?.current_min_fans) };
            })
            .filter((entry) => Number.isFinite(entry.day) && entry.value != null);
          const recent = series.slice(-7);
          const dailyChanges = [];
          for (let index = 1; index < recent.length; index++) {
            const dayGap = recent[index].day - recent[index - 1].day;
            if (dayGap > 0) dailyChanges.push((recent[index].value - recent[index - 1].value) / dayGap);
          }
          const recentDailyChange = getMedian(dailyChanges);
          const dayNumber = Math.max(1, Number(displaySnapshot?.day) || Number(displayedDay) || 1);
          const paceProjection = (row.current_min_fans / dayNumber) * monthLength;
          const trendProjection = row.current_min_fans + (recentDailyChange * Math.max(0, monthLength - dayNumber));
          const currentTrajectory = (paceProjection * 0.65) + (trendProjection * 0.35);
          const historicalBaseline = row.last_month_min_fans ?? currentTrajectory;
          projectedMinFans = Math.max(
            row.current_min_fans,
            Math.round((currentTrajectory * currentWeight) + (historicalBaseline * (1 - currentWeight)))
          );
        }
        return { ...row, projectedMinFans, forecastWeight: currentWeight };
      });

      if (!currentMonthActive) {
        return {
          ...base,
          status: "awaiting-current-month",
          rows,
          observationCount,
          asOfDay: finiteThresholdNumber(displaySnapshot?.day),
          asOfDate: displaySnapshot?.date || null,
          message: "UMA is still returning last month’s final cutoffs. Actual values are shown, but forecasts are withheld.",
        };
      }
      if (!ready) {
        const remaining = Math.max(0, 3 - observationCount);
        return {
          ...base,
          status: "collecting",
          rows,
          observationCount,
          asOfDay: finiteThresholdNumber(displaySnapshot?.day),
          asOfDate: displaySnapshot?.date || null,
          message: "Current-month thresholds detected. Collecting " + remaining + " more daily observation" + (remaining === 1 ? "" : "s") + " before forecasting.",
        };
      }
      return {
        status: "ready",
        ready: true,
        observationCount,
        rows,
        currentWeight,
        asOfDay: finiteThresholdNumber(displaySnapshot?.day),
        asOfDate: displaySnapshot?.date || null,
        message: Math.round(currentWeight * 100) + "% current threshold trajectory and " + Math.round((1 - currentWeight) * 100) + "% prior-month baseline.",
      };
    }

    function estimateRankFromThresholds(projectedFans, thresholdRows) {
      const fans = finiteThresholdNumber(projectedFans);
      const points = (Array.isArray(thresholdRows) ? thresholdRows : [])
        .map((row) => ({
          fans: finiteThresholdNumber(row?.projectedMinFans),
          rank: finiteThresholdNumber(row?.ranking_to),
        }))
        .filter((point) => point.fans != null && point.rank != null)
        .sort((a, b) => b.fans - a.fans);
      if (fans == null || !points.length) return null;
      if (fans >= points[0].fans) return Math.max(1, Math.round(points[0].rank));
      for (let index = 1; index < points.length; index++) {
        const higher = points[index - 1];
        const lower = points[index];
        if (fans < lower.fans) continue;
        const fanRange = higher.fans - lower.fans;
        const ratio = fanRange > 0 ? (higher.fans - fans) / fanRange : 1;
        return Math.round(higher.rank + (ratio * (lower.rank - higher.rank)));
      }
      return null;
    }

    function projectHistoricalRank(rankMap, monthKey, displayedDay, monthLength) {
      const points = Object.entries(rankMap || {})
        .filter(([dateKey, value]) => dateKey.startsWith(monthKey) && finiteThresholdNumber(value?.rank) != null)
        .map(([dateKey, value]) => ({ day: Number(dateKey.slice(-2)), rank: Number(value.rank) }))
        .filter((point) => Number.isFinite(point.day) && point.day <= displayedDay)
        .sort((a, b) => a.day - b.day)
        .slice(-7);
      if (!points.length) return null;
      if (points.length === 1) return points[0].rank;
      const first = points[0];
      const last = points[points.length - 1];
      const dayGap = last.day - first.day;
      const dailyRankMovement = dayGap > 0 ? (last.rank - first.rank) / dayGap : 0;
      return Math.max(1, Math.min(10000, Math.round(last.rank + (dailyRankMovement * Math.max(0, monthLength - displayedDay)))));
    }

    function getOfficialClubRankForecast(clubEntry, thresholdForecast, clubRankHistory, monthKey, displayedDay, monthLength) {
      if (!thresholdForecast?.ready || !clubEntry?.hasReliableHistory) return null;
      const thresholdRank = estimateRankFromThresholds(clubEntry.totalProjected, thresholdForecast.rows);
      if (thresholdRank == null) return null;
      const historicalRank = projectHistoricalRank(clubRankHistory, monthKey, displayedDay, monthLength);
      const estimatedRank = historicalRank == null
        ? thresholdRank
        : Math.round((thresholdRank * 0.90) + (historicalRank * 0.10));
      return {
        rank: Math.max(1, estimatedRank),
        thresholdRank,
        historicalRank,
        confidence: thresholdForecast.observationCount >= 7 ? "Moderate" : "Early estimate",
      };
    }

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
          accent: "#ffd0d8",
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
      if (!entry.id) return { label: "⏳ Not Configured", color: "#ae9aa5", sub: "Club JSON not set up yet" };
      if (!cdata) return { label: "❌ No JSON", color: "#f87171", sub: "No JSON file loaded" };
      if (cdata.archiveMonthKey && cdata.sourceType === DATA_SOURCE) return { label: "📦 Archive", color: "#ffd0d8", sub: `Snapshot month ${getMonthKeyLabel(cdata.archiveMonthKey)}` };

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
      return { color: "#ae9aa5", textShadow: "none" };
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
        currentRank: Number.isFinite(Number(clubRoot?.rank)) && Number(clubRoot.rank) > 0 ? Number(clubRoot.rank) : null,
        currentRankChange: Number.isFinite(Number(clubRoot?.rank_diff)) ? Number(clubRoot.rank_diff) : null,
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
        const endDay = Math.min(dim, day + 6);
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
        const ctx = canvas.getContext("2d"); ctx.fillStyle = "#120e12"; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        return await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
      } finally { URL.revokeObjectURL(svgUrl); }
    }

    function downloadBlob(blob, filename) {
      if (!blob) return; const url = URL.createObjectURL(blob); const a = document.createElement("a");
      a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    function safeFilename(value) { return String(value || "graph").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "graph"; }

    function ProgressBar({ pct, color = "#a93f56", height = 8 }) {
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
      if (delta == null) return (<span style={{ color: "#ae9aa5", fontSize: 10, fontWeight: 700 }}>—</span>);
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
          <span style={{ color: "#f3e9ee", fontWeight: 800, fontSize: isSmall ? 11 : 12, whiteSpace: "nowrap" }}>#{rank.toLocaleString()}</span>
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

    function HealthScoreComponent({ label, ratio = 0, weight = 0, accent = "#a93f56", helper = "" }) {
      const normalizedRatio = clamp01(ratio);
      const weightPoints = Math.round(weight * 100);
      const contributionPoints = Math.round(normalizedRatio * weight * 100);
      return (
        <div style={{ background: "#151115", border: "1px solid #3b2932", borderRadius: 10, padding: "10px 10px 9px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "baseline", marginBottom: 6 }}>
            <div style={{ color: "#ddc9d3", fontSize: 11, fontWeight: 700 }}>{label}</div>
            <div style={{ color: accent, fontSize: 11, fontWeight: 800, whiteSpace: "nowrap" }}>{Math.round(normalizedRatio * 100)}% · {contributionPoints}/{weightPoints} pts</div>
          </div>
          <div style={{ marginBottom: 6 }}><ProgressBar pct={normalizedRatio * 100} color={accent} height={5} /></div>
          <div style={{ color: "#ae9aa5", fontSize: 10, lineHeight: 1.35 }}>{helper} · Weight {weightPoints}%</div>
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

    function Sparkline({ data = [], visibleDayCount = null, width = 90, height = 26, color = "#a93f56" }) {
      const vals = getVisibleCumulativeSparklineValues(data, visibleDayCount);
      if (vals.length < 2) return <span style={{ color: "#a18c98", fontSize: 10 }}>—</span>;
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
      if (!fullTargetSeries.length) return (<div style={{ color: "#ae9aa5", fontSize: 12, padding: "18px 0" }}>Not enough daily data to render the pace chart yet.</div>);
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
              {gridValues.map((value, index) => { const y = yForValue(value); return (<g key={index}><line x1={padding.left} x2={width - padding.right} y1={y} y2={y} stroke="#3b2932" strokeDasharray="4 4" /><text x={padding.left - 10} y={y + 4} textAnchor="end" fill="#ae9aa5" fontSize="10">{fmt(value)}</text></g>); })}
              {weeks.filter((week) => week.startDay <= dayCount).map((week) => { const boundaryDay = Math.min(week.endDay, dayCount); const x = xForIndex(boundaryDay - 1); return (<g key={week.number}><line x1={x} x2={x} y1={padding.top} y2={height - padding.bottom} stroke="#50333f" strokeDasharray="3 5" /><text x={Math.max(padding.left + 12, x - 4)} y={padding.top + 12} textAnchor="end" fill="#ae9aa5" fontSize="10">W{week.number}</text></g>); })}
              <path d={pathFor(fullTargetSeries)} fill="none" stroke="#ffd0d8" strokeWidth="2.5" strokeDasharray="7 6" />
              {drawnSeriesList.map((item) => (<path key={`${item.name}-${mode}-${visibleDayCount}`} className="chart-line" pathLength="1" d={pathFor(item.series)} fill="none" stroke={item.color} strokeWidth="2" opacity="0.9" />))}
              <g><circle cx={currentX} cy={yForValue(fullTargetSeries[visibleDayCount - 1] ?? 0)} r="3.8" fill="#ffd0d8" style={{ filter: "drop-shadow(0 0 5px rgba(255,208,216,0.9))" }} /></g>
              {drawnSeriesList.map((item) => { const currentValue = item.series?.[visibleDayCount - 1] ?? 0; return (<g key={`${item.name}-current-dot`}><circle cx={currentX} cy={yForValue(currentValue)} r="3.2" fill={item.color} stroke="#120e12" strokeWidth="1" style={{ filter: `drop-shadow(0 0 4px ${item.color})` }} /></g>); })}
              {hover && (<><line x1={hover.x} x2={hover.x} y1={padding.top} y2={height - padding.bottom} stroke={isPinned ? "#f4a4b1" : "#a93f56"} strokeWidth={isPinned ? "2" : "1"} strokeDasharray="2 4" /><circle cx={hover.x} cy={hover.yTarget} r="4" fill="#ffd0d8" />{hoverMembers.filter((item) => item.value != null).map((item) => (<circle key={item.name} cx={hover.x} cy={yForValue(item.value)} r="3" fill={item.color} stroke="#120e12" strokeWidth="1" />))}</>)}
              {Array.from({ length: dayCount }, (_, index) => { const startX = index === 0 ? padding.left : (xForIndex(index - 1) + xForIndex(index)) / 2; const endX = index === dayCount - 1 ? width - padding.right : (xForIndex(index) + xForIndex(index + 1)) / 2; return (<g key={index}><rect x={startX} y={padding.top} width={Math.max(10, endX - startX)} height={innerH} fill="transparent" style={{ cursor: "pointer" }} onMouseEnter={() => { if (!isPinned) setHoverIdx(index); }} onMouseLeave={() => { if (!isPinned) setHoverIdx(null); }} onClick={() => { if (isPinned && pinnedIdx === index) setPinnedIdx(null); else setPinnedIdx(index); }} />{(index === 0 || index === dayCount - 1 || ((index + 1) % 5 === 0)) && (<text x={xForIndex(index)} y={height - padding.bottom + 18} textAnchor="middle" fill="#ae9aa5" fontSize="10">{index + 1}</text>)}</g>); })}
            </svg>
          </div>
          {hover && (<div style={{ position: "absolute", left: `${tooltipLeftPct}%`, top: 8, transform: `translateX(${tooltipTranslateX})`, background: "linear-gradient(168deg, rgba(47,29,39,0.97), rgba(25,18,24,0.98))", border: `1px solid ${isPinned ? "#f4a4b1" : "rgba(244,164,177,0.32)"}`, borderRadius: 12, padding: "11px 13px", minWidth: 330, width: "max-content", maxWidth: "min(92vw, 620px)", boxShadow: isPinned ? "0 1px 0 rgba(243,233,238,0.06) inset, 0 18px 44px rgba(169,63,86,0.3)" : "0 1px 0 rgba(243,233,238,0.06) inset, 0 18px 44px rgba(3,2,10,0.65)", pointerEvents: isPinned ? "auto" : "none", zIndex: 5, overflow: "visible" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, marginBottom: 7 }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 7 }}>
                <span className="telemetry" style={{ color: "#fff1f5", fontWeight: 700, fontSize: 13 }}>Day {hover.day}</span>
                <span style={{ color: "#c3a7b2", fontSize: 10, fontWeight: 700 }}>{getDateLabel(year, monthIndex, hover.day)}</span>
              </div>
              {isPinned && (<span style={{ color: "#f4a4b1", fontSize: 10, fontWeight: 700, display: "inline-flex", alignItems: "center", gap: 4, background: "#f4a4b122", border: "1px solid #f4a4b144", borderRadius: 999, padding: "2px 8px", cursor: "pointer" }} onClick={() => setPinnedIdx(null)}>📌 Pinned — unpin</span>)}
            </div>
            <div style={{ display: "inline-flex", alignItems: "center", gap: 6, marginBottom: 9, padding: "3px 9px", borderRadius: 999, background: "rgba(255,208,216,0.1)", border: "1px solid rgba(255,208,216,0.3)" }}>
              <span style={{ width: 12, height: 0, borderTop: "2.5px dashed #ffd0d8", display: "inline-block" }} />
              <span style={{ color: "#ffd0d8", fontSize: 10.5, fontWeight: 700 }}>{targetLabel}: {fmt(hover.target)}</span>
            </div>
            {hoverMembers.length === 0 ? (<div style={{ color: "#ae9aa5", fontSize: 11 }}>Turn on at least one member card to compare lines against the plan.</div>) : (hoverMembers.map((item, idx) => {
              const ps = getPodiumStyle(idx);
              const ahead = item.delta != null && item.delta >= 0;
              const barPct = item.value == null || hover.target <= 0 ? null : Math.min(100, Math.max(0, (item.value / hover.target) * 100));
              return (
                <div key={item.name} style={{ marginBottom: 6 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 14, alignItems: "center", fontSize: 11, whiteSpace: "nowrap" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0 }}>
                      <span className="telemetry" style={{ color: ps.color, textShadow: ps.textShadow, fontSize: 10, fontWeight: 700, minWidth: 16, textAlign: "right" }}>{item.value == null ? "·" : `P${idx + 1}`}</span>
                      <span style={{ width: 8, height: 8, borderRadius: 999, background: item.color, flexShrink: 0, boxShadow: `0 0 7px ${item.color}` }} />
                      <span style={{ color: "#fff1f5", fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis" }}>{item.name}</span>
                    </div>
                    <div style={{ textAlign: "right", display: "flex", alignItems: "center", gap: 7 }}>
                      <span style={{ color: item.value == null ? "#ae9aa5" : "#fff1f5", fontWeight: 800 }}>{fmt(item.value)}</span>
                      <span style={{ color: item.delta == null ? "#ae9aa5" : ahead ? "#34d399" : "#f87171", fontWeight: 700, fontSize: 10, background: item.delta == null ? "transparent" : ahead ? "rgba(52,211,153,0.12)" : "rgba(248,113,113,0.12)", border: item.delta == null ? "none" : `1px solid ${ahead ? "rgba(52,211,153,0.35)" : "rgba(248,113,113,0.35)"}`, borderRadius: 999, padding: "1px 7px", minWidth: 58, display: "inline-block" }}>{fmtSigned(item.delta)}</span>
                    </div>
                  </div>
                  {mode === "cumulative" && barPct != null && (
                    <div style={{ marginTop: 3, marginLeft: 31, height: 3, borderRadius: 99, background: "rgba(244,164,177,0.12)", overflow: "hidden" }}>
                      <div style={{ width: `${barPct}%`, height: "100%", borderRadius: 99, background: `linear-gradient(90deg, ${item.color}, ${ahead ? "#34d399" : "#f87171"})` }} />
                    </div>
                  )}
                </div>
              );
            }))}
          </div>)}
          <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginTop: 10, color: "#9ca3af", fontSize: 11 }}><span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><span style={{ width: 14, height: 3, background: "#ffd0d8", borderRadius: 99, display: "inline-block" }} />{targetLabel}</span>{drawnSeriesList.map((item) => (<span key={item.name} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><span style={{ width: 14, height: 3, background: item.color, borderRadius: 99, display: "inline-block" }} />{item.name}</span>))}</div>
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
            <div style={{ background: '#120e12', color: '#f3e9ee', minHeight: '100vh', padding: 24, fontFamily: "'Inter',system-ui,sans-serif" }}>
              <div style={{ maxWidth: 980, margin: '0 auto', background: '#1d171c', border: '1px solid #7f1d1d', borderRadius: 14, padding: 18 }}>
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
      if (!lines.length) return (<div style={{ color: "#ae9aa5", fontSize: 12, padding: "18px 0" }}>No club data available for the network pace chart.</div>);
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
            {gridVals.map((v) => { const y = yV(v); return (<g key={v}><line x1={pad.left} x2={W - pad.right} y1={y} y2={y} stroke="#3b2932" strokeDasharray="4 4" /><text x={pad.left - 8} y={y + 4} textAnchor="end" fill="#ae9aa5" fontSize="10">{mode === "daily" ? `${v.toFixed(2)}%` : `${v}%`}</text></g>); })}
            <path d={pathFor(targetSeries)} fill="none" stroke="#ffd0d8" strokeWidth="2.5" strokeDasharray="7 6" />
            {lines.map((l) => (<path key={`${l.name}-${mode}-${visibleDayCount}`} className="chart-line" pathLength="1" d={pathFor(l.series)} fill="none" stroke={l.clubColor} strokeWidth="2.5" opacity="0.85" />))}
            <circle cx={currentX} cy={yV(targetSeries[visibleDayCount - 1] ?? 0)} r="4" fill="#ffd0d8" style={{ filter: "drop-shadow(0 0 5px rgba(255,208,216,0.9))" }} />
            {lines.map((l) => (<circle key={`${l.name}-current`} cx={currentX} cy={yV(l.series[visibleDayCount - 1] ?? 0)} r="3.5" fill={l.clubColor} stroke="#120e12" strokeWidth="1" style={{ filter: `drop-shadow(0 0 4px ${l.clubColor})` }} />))}
            {hoverIdx != null && (<line x1={xI(hoverIdx)} x2={xI(hoverIdx)} y1={pad.top} y2={H - pad.bottom} stroke="#a93f56" strokeDasharray="2 4" />)}
            {Array.from({ length: dim }, (_, i) => { const sx = i === 0 ? pad.left : (xI(i - 1) + xI(i)) / 2; const ex = i === dim - 1 ? W - pad.right : (xI(i) + xI(i + 1)) / 2; return (<rect key={i} x={sx} y={pad.top} width={Math.max(10, ex - sx)} height={innerH} fill="transparent" onMouseEnter={() => setHoverIdx(i)} onMouseLeave={() => setHoverIdx(null)} />); })}
            {hoverIdx != null && lines.filter((l) => hoverIdx < visibleDayCount).map((l) => (<circle key={l.name} cx={xI(hoverIdx)} cy={yV(l.series[hoverIdx] ?? 0)} r="4" fill={l.clubColor} stroke="#120e12" strokeWidth="1" />))}
            {Array.from({ length: dim }, (_, i) => (i === 0 || i === dim - 1 || ((i + 1) % 5 === 0)) ? (<text key={i} x={xI(i)} y={H - pad.bottom + 18} textAnchor="middle" fill="#ae9aa5" fontSize="10">{i + 1}</text>) : null)}
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
              <div style={{ position: "absolute", left: `${Math.max(14, Math.min(86, (xI(hoverIdx) / W) * 100))}%`, top: 8, transform: "translateX(-50%)", background: "linear-gradient(168deg, rgba(47,29,39,0.97), rgba(25,18,24,0.98))", border: "1px solid rgba(244,164,177,0.32)", borderRadius: 12, padding: "10px 12px", minWidth: 330, boxShadow: "0 1px 0 rgba(243,233,238,0.06) inset, 0 18px 44px rgba(3,2,10,0.65)", pointerEvents: "none", zIndex: 5 }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 12, marginBottom: 7 }}>
                  <div style={{ color: "#f3e9ee", fontWeight: 800, fontSize: 12 }}>Day {hoverIdx + 1}</div>
                  <div style={{ color: "#ffd0d8", fontSize: 11, fontWeight: 700 }}>{targetLabel}: {mode === "daily" ? `${(target ?? 0).toFixed(2)}%` : `${Math.round(target ?? 0)}%`}</div>
                </div>
                {rows.map((l) => {
                  const onPace = l.pct != null && l.pct >= target;
                  return (
                    <div key={l.name} style={{ marginBottom: 6 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", gap: 14, fontSize: 11 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 6, color: "#f3e9ee", minWidth: 0 }}><span style={{ width: 8, height: 8, borderRadius: 999, background: l.clubColor, flexShrink: 0, boxShadow: `0 0 7px ${l.clubColor}` }} />{l.clubName} <TierBadge tier={l.tier} /></div>
                        <div style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                          <span style={{ color: l.abs == null ? "#ae9aa5" : "#f3e9ee", fontWeight: 800 }} title={l.abs == null ? "" : `${fmtFull(l.abs)} fans ${mode === "daily" ? "gained this day" : "gained so far"}`}>{l.abs == null ? "—" : fmt(l.abs)}</span>
                          <span style={{ color: l.pct == null ? "#ae9aa5" : onPace ? "#34d399" : "#f87171", fontWeight: 700, marginLeft: 7 }}>{l.pct == null ? "—" : (mode === "daily" ? `${l.pct.toFixed(2)}%` : `${l.pct.toFixed(1)}%`)}</span>
                        </div>
                      </div>
                      {mode === "cumulative" && l.pct != null && (
                        <div style={{ marginTop: 3, height: 3, borderRadius: 99, background: "rgba(244,164,177,0.12)", overflow: "hidden" }}>
                          <div style={{ width: `${Math.min(100, Math.max(0, l.pct))}%`, height: "100%", borderRadius: 99, background: `linear-gradient(90deg, ${l.clubColor}, ${onPace ? "#34d399" : "#f87171"})` }} />
                        </div>
                      )}
                    </div>
                  );
                })}
                <div style={{ display: "flex", justifyContent: "space-between", gap: 14, fontSize: 11, marginTop: 7, paddingTop: 7, borderTop: "1px solid rgba(244,164,177,0.22)" }}>
                  <div style={{ color: "#ffd0d8", fontWeight: 800 }}>⬡ Network total</div>
                  <div style={{ whiteSpace: "nowrap" }}>
                    <span style={{ color: "#f3e9ee", fontWeight: 800 }} title={`${fmtFull(totalAbs)} fans across all clubs`}>{isLive ? fmt(totalAbs) : "—"}</span>
                    {totalPct != null && isLive && <span style={{ color: totalPct >= target ? "#34d399" : "#f87171", fontWeight: 700, marginLeft: 7 }}>{mode === "daily" ? `${totalPct.toFixed(2)}%` : `${totalPct.toFixed(1)}%`}</span>}
                  </div>
                </div>
              </div>
            );
          })()}
          <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginTop: 10, color: "#9ca3af", fontSize: 11 }}><span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><span style={{ width: 14, height: 3, background: "#ffd0d8", borderRadius: 99, display: "inline-block" }} />{targetLabel}</span>{lines.map((l) => (<span key={l.name} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><span style={{ width: 14, height: 3, background: l.clubColor, borderRadius: 99, display: "inline-block" }} />{l.clubName}</span>))}</div>
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
      if (!clubLines.length) return (<div style={{ color: "#ae9aa5", fontSize: 12, padding: "18px 0" }}>No rank history data available yet.</div>);
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
            {tierBounds.map((tb) => (<g key={tb.tier}><line x1={pad.left} x2={W - pad.right} y1={tb.y} y2={tb.y} stroke="#3b2932" strokeDasharray="4 4" /><image href={getRankIconUrl(tb.tier, rankingConfig)} x={4} y={tb.y - 10} width="20" height="20" /><text x={28} y={tb.y + 4} fill="#ae9aa5" fontSize="10" textAnchor="start">{tb.tier}</text><text x={pad.left - 6} y={tb.y + 4} fill="#a18c98" fontSize="9" textAnchor="end">#{tb.rank.toLocaleString()}</text></g>))}
            {clubLines.map((c) => (<path key={`${c.id}-${latestDay}`} className="chart-line" pathLength="1" d={buildPath(c.rankSeries)} fill="none" stroke={c.clubColor} strokeWidth="2.5" opacity="0.85" />))}
            {clubLines.map((c) => { const r = c.rankSeries[latestDay]; return r != null ? <circle key={`${c.id}-d`} cx={xI(latestDay)} cy={yV(r)} r="4" fill={c.clubColor} stroke="#120e12" strokeWidth="1.5" style={{ filter: `drop-shadow(0 0 4px ${c.clubColor})` }} /> : null; })}
            {hoverIdx != null && hoverIdx <= latestDay && (<line x1={xI(hoverIdx)} x2={xI(hoverIdx)} y1={pad.top} y2={H - pad.bottom} stroke="#a93f56" strokeDasharray="2 4" />)}
            {hoverIdx != null && hoverIdx <= latestDay && clubLines.map((c) => { const r = c.rankSeries[hoverIdx]; return r != null ? <circle key={`${c.id}-h`} cx={xI(hoverIdx)} cy={yV(r)} r="4" fill={c.clubColor} stroke="#120e12" strokeWidth="1" /> : null; })}
            {Array.from({ length: dim }, (_, i) => { const sx = i === 0 ? pad.left : (xI(i - 1) + xI(i)) / 2; const ex = i === dim - 1 ? W - pad.right : (xI(i) + xI(i + 1)) / 2; return <rect key={i} x={sx} y={pad.top} width={Math.max(10, ex - sx)} height={innerH} fill="transparent" onMouseEnter={() => setHoverIdx(i)} onMouseLeave={() => setHoverIdx(null)} />; })}
            {Array.from({ length: dim }, (_, i) => (i === 0 || i === dim - 1 || ((i + 1) % 5 === 0)) ? <text key={i} x={xI(i)} y={H - pad.bottom + 18} textAnchor="middle" fill={i <= latestDay ? "#ae9aa5" : "#312b4a"} fontSize="10">{i + 1}</text> : null)}
          </svg>
          {hoverIdx != null && hoverIdx <= latestDay && (() => { const dayNum = hoverIdx + 1; const dk = dateKeyForDay(dayNum); const items = clubLines.map((c) => ({ ...c, rank: c.rankSeries[hoverIdx] })).filter((c) => c.rank != null).sort((a, b) => a.rank - b.rank); if (!items.length) return null; const tx = Math.max(14, Math.min(86, (xI(hoverIdx) / W) * 100)); return (<div style={{ position: "absolute", left: `${tx}%`, top: 8, transform: "translateX(-50%)", background: "#1d171c", border: "1px solid #50333f", borderRadius: 10, padding: "10px 12px", minWidth: 220, boxShadow: "0 16px 40px rgba(0,0,0,0.35)", pointerEvents: "none", zIndex: 5 }}><div style={{ color: "#f3e9ee", fontWeight: 700, fontSize: 12, marginBottom: 6 }}>Day {dayNum} · {dk}</div>{items.map((c) => { const tier = getTierForRank(c.rank, rankingConfig); return (<div key={c.id} style={{ display: "flex", justifyContent: "space-between", gap: 14, fontSize: 11, marginBottom: 3 }}><div style={{ display: "flex", alignItems: "center", gap: 6, color: "#f3e9ee" }}><span style={{ width: 8, height: 8, borderRadius: 999, background: c.clubColor, flexShrink: 0 }} />{c.clubName || c.name}</div><div style={{ display: "flex", alignItems: "center", gap: 4 }}>{tier && <TierIcon tier={tier} size={14} showFallbackText={false} rankingConfig={rankingConfig} rankIconPath={rankIconPath} />}<span style={{ color: "#f3e9ee", fontWeight: 700 }}>#{c.rank.toLocaleString()}</span></div></div>); })}</div>); })()}
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
      const [networkMemberClubFilter, setNetworkMemberClubFilter] = useState("all");
      const [rankingsTab, setRankingsTab] = useState(initialRoute.rankingsTab);
      const [networkMemberVisibleCount, setNetworkMemberVisibleCount] = useState(RANKINGS_MEMBER_DEFAULT_COUNT);
      const [criticalClubFilter, setCriticalClubFilter] = useState("all");
      const [criticalSort, setCriticalSort] = useState({ key: "planDelta", direction: "asc" });
      const [criticalVisibleCount, setCriticalVisibleCount] = useState(10);
      const [pacePinnedIdx, setPacePinnedIdx] = useState(null);
      const [paceCardsCollapsed, setPaceCardsCollapsed] = useState(true);
      useEffect(() => {
        if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
        const root = document.getElementById('root');
        const animation = root?.animate?.([{opacity:0.65},{opacity:1}], {duration:180,easing:'ease-out'});
        return () => animation?.cancel();
      }, [tab, rankingsTab, activeIdx, clubsPageSelectedIdx, paceCardsCollapsed]);
      const [weeklyCopied, setWeeklyCopied] = useState(false);
      const [animationExportState, setAnimationExportState] = useState(false);
      const [animationDragAsset, setAnimationDragAsset] = useState(null);
      const [rankHistory, setRankHistory] = useState({});
      const [rankThresholdData, setRankThresholdData] = useState(null);
      const [rankThresholdError, setRankThresholdError] = useState("");
      const [demotionVisibleCount, setDemotionVisibleCount] = useState(10);
      const [promotionVisibleCount, setPromotionVisibleCount] = useState(10);
      const paceSvgRef = useRef(null);
      const paceContainerRef = useRef(null);
      const animationAssetCacheRef = useRef({ key: "", file: null, promise: null });
      const scheduledRefreshCycleRef = useRef(null);
      const scheduledRefreshTimeoutsRef = useRef([]);

      const now = new Date();
      const refreshScheduleMeta = getRefreshScheduleMeta(now);
      const animationBuildMode = new URLSearchParams(window.location.search).get("animationBuild") === "1";
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
            color: "#ffd0d8",
            bg: "#a93f5618",
            border: "#a93f5655",
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
      const thresholdMonthKey = formatDateKey(year, monthIndex + 1, 1).slice(0, 7);
      const rankThresholdForecast = buildRankThresholdForecast(rankThresholdData, thresholdMonthKey, today, dim);
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
      const clubName = club.name || data?.clubName;
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
          currentRank: result.currentRank ?? null,
          currentRankChange: result.currentRankChange ?? null,
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
        if (!(["rankings", "archives", "club"].includes(PAGE_MODE)) || isArchiveView) return undefined;
        let cancelled = false;
        const loadRankThresholds = async () => {
          const errors = [];
          for (const url of RANK_THRESHOLD_DATA_PATHS) {
            try {
              const response = await fetch(url, { headers: { Accept: "application/json" }, cache: "no-store" });
              if (!response.ok) {
                errors.push(url + ": HTTP " + response.status);
                continue;
              }
              const json = await response.json();
              if (!cancelled) {
                setRankThresholdData(json);
                setRankThresholdError("");
              }
              return;
            } catch (error) {
              errors.push(url + ": " + error.message);
            }
          }
          if (!cancelled) {
            setRankThresholdData(null);
            setRankThresholdError(errors.join(" | "));
          }
        };
        loadRankThresholds();
        return () => { cancelled = true; };
      }, [isArchiveView]);

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
      useEffect(() => { setNetworkMemberVisibleCount(RANKINGS_MEMBER_DEFAULT_COUNT); }, [topNetworkMode, networkMemberClubFilter]);
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
      const clubGoalProgressRatio = clubMonthlyTarget > 0 ? totalMonthly / clubMonthlyTarget : 0;
      const clubProjectedRatio = clubMonthlyTarget > 0 ? totalProj / clubMonthlyTarget : 0;
      const clubTopContributor = sortedByMonthly[0] || null;
      const clubLargestPlanGap = [...decoratedMembers].sort((a, b) => (a.plan.delta ?? 0) - (b.plan.delta ?? 0))[0] || null;
      const clubOutlookLabel = clubProjectedRatio >= 1.05 ? "Comfortably on target" : clubProjectedRatio >= 1 ? "Projected to reach target" : clubProjectedRatio >= 0.9 ? "Close to target" : "Needs attention";
      const clubOutlookColor = clubProjectedRatio >= 1.05 ? "#34d399" : clubProjectedRatio >= 1 ? "#60a5fa" : clubProjectedRatio >= 0.9 ? "#fbbf24" : "#f87171";
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
        const requiredHistoryDays = Math.max(3, Math.ceil(today * 0.70));
        const historyEligibleMembers = decorated.filter((member) => {
          const observedDays = Array.from(new Set((member.observedHistoryDays || [])
            .map((observedDay) => Number(observedDay))
            .filter((observedDay) => Number.isFinite(observedDay) && observedDay >= 1 && observedDay <= today)))
            .sort((a, b) => a - b);
          if (!observedDays.length) return false;
          const startedNearMonthStart = observedDays[0] <= Math.min(3, today);
          const currentThroughDisplayedDay = observedDays[observedDays.length - 1] >= Math.max(1, today - 2);
          return startedNearMonthStart && currentThroughDisplayedDay && observedDays.length >= requiredHistoryDays;
        }).length;
        const historyCoverageRatio = decorated.length > 0 ? historyEligibleMembers / decorated.length : 0;
        const hasReliableHistory = hasComparisonData && decorated.length > 0 && historyCoverageRatio >= 0.70;
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
          ...entry, clubName: entry.name || cdata?.clubName, activeMembers: decorated.length,
          totalFans: decorated.reduce((sum, member) => sum + (member.fans || 0), 0),
          totalMonthly: totalM, totalDaily, previousDaily, dailyTrendDelta, totalProjected: totalP,
          totalExpected: Math.round((decorated.length * entry.target / Math.max(dim, 1)) * today),
          hasData: Boolean(cdata), lastFetch: cdata?.lastFetch || null, refreshedAt: cdata?.refreshedAt || null,
          sourceUpdatedAt: cdata?.sourceUpdatedAt || null, jsonMeta: getJsonLoadMeta(entry, cdata, now),
          statusCounts: clubStatusCounts,
          topFiveMembers: [...decorated].sort((a, b) => (b.monthlyGain ?? 0) - (a.monthlyGain ?? 0)).slice(0, 5),
          health, pctOnTrack, projectedRatio, nonStagnantRatio, nonStagnantMembers: nonStagnant, clubTarget,
          historyEligibleMembers, historyCoverageRatio, hasReliableHistory,
          clubDailySeries, clubCumSeries, clubPctSeries, clubDailyPctSeries, clubColor: getClubColor(viewClubs.indexOf(entry)),
          currentMonthlyRank: ri.rank, rankDelta: ri.delta,
        };
      });

      const officialRankForecastByClubId = networkClubs.reduce((result, entry) => {
        result[entry.id] = getOfficialClubRankForecast(
          entry,
          rankThresholdForecast,
          rankHistory[entry.id],
          thresholdMonthKey,
          today,
          dim
        );
        return result;
      }, {});

      const networkMembers = networkClubs.filter((entry) => entry.id && clubData[entry.id]).flatMap((entry) => {
        const members = (clubData[entry.id]?.members || []).filter((member) => member.isActive !== false).map((member) => ({ ...decorateMember(member, entry.target), clubName: entry.name || clubData[entry.id]?.clubName, clubTier: entry.tier, clubTarget: entry.target }));
        return members;
      }).sort((a, b) => { const monthDiff = (b.monthlyGain ?? Number.NEGATIVE_INFINITY) - (a.monthlyGain ?? Number.NEGATIVE_INFINITY); if (monthDiff !== 0) return monthDiff; const projectedDiff = (b.projected ?? Number.NEGATIVE_INFINITY) - (a.projected ?? Number.NEGATIVE_INFINITY); if (projectedDiff !== 0) return projectedDiff; return (a.name || "").localeCompare(b.name || ""); });

      const individualRankPool = networkMemberClubFilter === "all" ? networkMembers : networkMembers.filter((member) => member.clubName === networkMemberClubFilter);
      const topNetworkUsers = hasComparisonData ? [...individualRankPool].sort((a, b) => { if (topNetworkMode === "monthly") { const monthDiff = (b.monthlyGain ?? Number.NEGATIVE_INFINITY) - (a.monthlyGain ?? Number.NEGATIVE_INFINITY); if (monthDiff !== 0) return monthDiff; const dayDiff = (b.dailyGain ?? Number.NEGATIVE_INFINITY) - (a.dailyGain ?? Number.NEGATIVE_INFINITY); if (dayDiff !== 0) return dayDiff; } else { const dayDiff = (b.dailyGain ?? Number.NEGATIVE_INFINITY) - (a.dailyGain ?? Number.NEGATIVE_INFINITY); if (dayDiff !== 0) return dayDiff; const monthDiff = (b.monthlyGain ?? Number.NEGATIVE_INFINITY) - (a.monthlyGain ?? Number.NEGATIVE_INFINITY); if (monthDiff !== 0) return monthDiff; } return (a.name || "").localeCompare(b.name || ""); }) : [];
      const individualQuotaHitters = individualRankPool.filter((member) => (member.projected ?? 0) >= member.clubTarget).length;
      const individualHighOutlook = individualRankPool.filter((member) => (member.projected ?? 0) >= member.clubTarget * 1.25).length;
      const representedTopClubs = new Set(topNetworkUsers.slice(0, 25).map((member) => member.clubName)).size;
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
      const forecastReadyClubs = networkClubs.filter((entry) => entry.id && entry.hasData && entry.hasReliableHistory);
      const partialHistoryClubs = networkClubs.filter((entry) => entry.id && entry.hasData && !entry.hasReliableHistory);
      const clubsProjectedToGoal = forecastReadyClubs.filter((entry) => entry.projectedRatio >= 1);
      const clubsAheadOfPlan = forecastReadyClubs.filter((entry) => entry.totalMonthly >= entry.totalExpected);
      const clubsAtRisk = forecastReadyClubs.filter((entry) => entry.projectedRatio < 0.90);
      const bestRankedClub = rankedNetworkClubs.find((entry) => entry.currentMonthlyRank != null) || null;
      const strongestOutlookClub = forecastReadyClubs.reduce((best, entry) => !best || entry.projectedRatio > best.projectedRatio ? entry : best, null);
      const weakestOutlookClub = forecastReadyClubs.reduce((weakest, entry) => !weakest || entry.projectedRatio < weakest.projectedRatio ? entry : weakest, null);
      const strongestRankMover = rankedNetworkClubs.filter((entry) => (entry.rankDelta ?? 0) > 0).reduce((best, entry) => !best || entry.rankDelta > best.rankDelta ? entry : best, null);
      const largestRankDrop = rankedNetworkClubs.filter((entry) => (entry.rankDelta ?? 0) < 0).reduce((worst, entry) => !worst || entry.rankDelta < worst.rankDelta ? entry : worst, null);
      const healthiestClub = forecastReadyClubs.reduce((best, entry) => !best || entry.health.score > best.health.score ? entry : best, null);
      const networkClubTargetTotal = forecastReadyClubs.reduce((sum, entry) => sum + entry.clubTarget, 0);
      const networkProjectedTotal = forecastReadyClubs.reduce((sum, entry) => sum + entry.totalProjected, 0);
      const networkProjectedRatio = networkClubTargetTotal > 0 ? networkProjectedTotal / networkClubTargetTotal : 0;
      function getClubOutlookMeta(entry) {
        if (!hasComparisonData) return { label: `Waiting for Day ${today + 1}`, color: "#9ca3af", bg: "#9ca3af18", border: "#9ca3af44" };
        if (!entry.hasReliableHistory) return { label: "Partial data", color: "#9ca3af", bg: "#9ca3af18", border: "#9ca3af44" };
        if (entry.projectedRatio >= 1.05) return { label: "Comfortable", color: "#34d399", bg: "#34d39918", border: "#34d39944" };
        if (entry.projectedRatio >= 1) return { label: "On target", color: "#60a5fa", bg: "#60a5fa18", border: "#60a5fa44" };
        if (entry.projectedRatio >= 0.90) return { label: "Close", color: "#fbbf24", bg: "#fbbf2418", border: "#fbbf2444" };
        return { label: "At risk", color: "#f87171", bg: "#f8717118", border: "#f8717144" };
      }
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

        const rankMap = rankHistory[cid] || {};
        const rankEntriesByDay = new Map();
        Object.entries(rankMap).forEach(([dateKey, entry]) => {
          const entryDate = dateKeyToLocalDate(dateKey);
          const entryDay = entryDate.getFullYear() === year && entryDate.getMonth() === monthIndex
            ? entryDate.getDate()
            : null;
          const rank = Number(entry?.rank);
          if (entryDay == null || entryDay > today || !Number.isFinite(rank) || rank <= 0) return;
          rankEntriesByDay.set(entryDay, { ...entry, rank, day: entryDay });
        });
        (Array.isArray(data?.clubDailyHistory) ? data.clubDailyHistory : []).forEach((entry) => {
          const entryDay = Number(entry?.actual_date);
          const rank = Number(entry?.rank);
          if (!Number.isFinite(entryDay) || entryDay < 1 || entryDay > today || !Number.isFinite(rank) || rank <= 0) return;
          rankEntriesByDay.set(entryDay, {
            rank,
            rank_gain: entry?.rank_gain == null ? null : Number(entry.rank_gain),
            day: entryDay,
          });
        });
        const liveClubRank = Number(data?.currentRank);
        if (Number.isFinite(liveClubRank) && liveClubRank > 0 && !rankEntriesByDay.has(today)) {
          rankEntriesByDay.set(today, {
            rank: liveClubRank,
            rank_gain: data?.currentRankChange == null ? null : Number(data.currentRankChange),
            day: today,
          });
        }
        const resolvedRankEntries = [...rankEntriesByDay.values()].sort((a, b) => b.day - a.day);
        const currentRankEntry = resolvedRankEntries[0] || null;
        const previousRankEntry = currentRankEntry
          ? resolvedRankEntries.find((entry) => entry.day < currentRankEntry.day) || null
          : null;
        const currentRankValue = Number(currentRankEntry?.rank);
        const previousRankValue = Number(previousRankEntry?.rank);
        const storedRankChange = Number(currentRankEntry?.rank_gain);
        const computedRankChange = Number.isFinite(currentRankValue) && Number.isFinite(previousRankValue)
          ? previousRankValue - currentRankValue
          : null;
        const rankChange = currentRankEntry?.rank_gain != null && Number.isFinite(storedRankChange)
          ? storedRankChange
          : computedRankChange;
        const rankValue = Number.isFinite(currentRankValue) && currentRankValue > 0 ? currentRankValue : null;
        const rankChangeLabel = rankChange == null
          ? "change unavailable"
          : rankChange > 0
            ? `▲${Math.abs(rankChange).toLocaleString()} vs prior day`
            : rankChange < 0
              ? `▼${Math.abs(rankChange).toLocaleString()} vs prior day`
              : "— no change vs prior day";
        const rankSummaryLine = rankValue == null
          ? "🌐 Club Rank: —"
          : `🌐 Club Rank: #${rankValue.toLocaleString()} · ${rankChange > 0 ? "🟢 " : rankChange < 0 ? "🔴 " : ""}${rankChangeLabel}`;

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
          `📊 **[${club.tier}] ${club.name} — Daily Report** | ${ds}`,
          `${getDiscordPingLabel()}`,
          `🗂️ Source: ${getSourceLabel()}`,
          `🎯 Target: ${fmt(club.target)}/member · 👥 ${decoratedMembers.length}/${viewMaxMembers} active · 📅 Day ${today}/${dim}`,
          rankSummaryLine,
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
            name: member.name,
            dailyGain: member.dailyGain ?? 0,
            monthlyGain: member.monthlyGain ?? 0,
            paceDelta: member.plan.delta ?? 0,
            rolling3DayAvg: member.rolling3DayAvg ?? 0,
            fansNeededForPlan: member.fansNeededForPlan ?? 0,
            stagnantDays: member.stagnantDays ?? 0,
            daysToTarget: Number.isFinite(member.daysToTarget) ? member.daysToTarget : null,
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
          fullMessage,
          reportMeta: {
            dateLabel: ds,
            dayLabel: `Day ${today} of ${dim}`,
            sourceLabel: getSourceLabel(),
            pingLabel: getDiscordPingLabel(),
            activeLabel: `${decoratedMembers.length}/${viewMaxMembers} active`,
            targetLabel: `${fmt(club.target)} / member`,
            rankValue,
            rankLabel: rankValue == null ? "—" : `#${rankValue.toLocaleString()}`,
            rankChange,
            rankChangeLabel,
            dailyValue: totalDaily,
            previousDailyValue: totalPreviousDaily,
            dailyTrendDelta: clubDailyTrendDelta,
            dailyHistory: activeClubDailyMetrics.clubDailySeries.slice(0, today).map((value) => Number(value || 0)),
            monthValue: totalMonthly,
            paceValue: hasComparisonData ? clubWeeklyDelta : null,
            projectedValue: totalProj,
            targetValue: clubMonthlyTarget,
            expectedValue: clubExpectedToDate,
            daysRemaining: daysLeft,
            dailyLabel: fmtSigned(totalDaily),
            monthLabel: fmtSigned(totalMonthly),
            paceLabel: hasComparisonData ? fmtSigned(clubWeeklyDelta) : "—",
            pacePositive: hasComparisonData && clubWeeklyDelta >= 0,
            onTrack: statusCounts["on-track"],
            behind: statusCounts["behind"],
            critical: statusCounts["critical"],
          }
        };
      }

      function buildDiscord() {
        return getDiscordExportData().fullMessage;
      }

      async function renderDiscordTablePng(exportData = getDiscordExportData(), scale = 2) {
        const report = exportData.reportMeta;
        if (!report || !exportData.tableRows.length) return null;

        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d");
        if (!ctx) return null;

        const loadCanvasImage = (url) => new Promise((resolve) => {
          if (!url) {
            resolve(null);
            return;
          }
          const image = new Image();
          image.onload = () => resolve(image);
          image.onerror = () => resolve(null);
          image.src = url;
        });
        const tierIconUrl = getRankIconUrl(club.tier, viewRankingConfig, viewRankIconPath);
        const currentRankTier = getTierForRank(report.rankValue, viewRankingConfig);
        const currentRankIconUrl = getRankIconUrl(currentRankTier, viewRankingConfig, viewRankIconPath);
        const tierIconImage = await loadCanvasImage(tierIconUrl);
        const currentRankIconImage = currentRankIconUrl === tierIconUrl
          ? tierIconImage
          : await loadCanvasImage(currentRankIconUrl);
        const rankIconImage = currentRankIconImage || tierIconImage;

        const width = 1160;
        const outerPadding = 44;
        const headerHeight = 126;
        const metricHeight = 152;
        const metricGap = 14;
        const statusHeight = 76;
        const tableHeaderHeight = 66;
        const rowHeight = 76;
        const footerHeight = 78;
        const sectionGap = 22;
        const height = outerPadding + headerHeight + sectionGap + metricHeight + sectionGap + statusHeight + sectionGap + tableHeaderHeight + (exportData.tableRows.length * rowHeight) + footerHeight + outerPadding;

        canvas.width = Math.ceil(width * scale);
        canvas.height = Math.ceil(height * scale);

        ctx.scale(scale, scale);
        ctx.textBaseline = "top";
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";

        const roundedRect = (x, y, w, h, r) => {
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
        const fillRounded = (x, y, w, h, r, fill, stroke = null) => {
          roundedRect(x, y, w, h, r);
          ctx.fillStyle = fill;
          ctx.fill();
          if (stroke) {
            ctx.strokeStyle = stroke;
            ctx.lineWidth = 1;
            ctx.stroke();
          }
        };
        const setFont = (weight, size, family = "Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif") => {
          ctx.font = `${weight} ${size}px ${family}`;
        };
        const fitText = (value, maxWidth) => {
          const text = String(value ?? "");
          if (ctx.measureText(text).width <= maxWidth) return text;
          let output = text;
          while (output.length > 1 && ctx.measureText(`${output}…`).width > maxWidth) output = output.slice(0, -1);
          return `${output}…`;
        };
        const drawLabel = (label, x, y, color = "#8f93ad") => {
          setFont(700, 16);
          ctx.fillStyle = color;
          ctx.fillText(String(label).toUpperCase(), x, y);
        };
        const drawMetricCard = ({ x, y, w, label, value, detail, accent, detailColor = "#9ca3af" }) => {
          fillRounded(x, y, w, metricHeight, 18, "#17182a", "#2a2c45");
          fillRounded(x, y, 5, metricHeight, 3, accent);
          drawLabel(label, x + 22, y + 20);
          setFont(800, 38);
          ctx.fillStyle = "#f8fafc";
          ctx.fillText(value, x + 22, y + 49);
          setFont(650, 18);
          ctx.fillStyle = detailColor;
          ctx.fillText(fitText(detail, w - 44), x + 22, y + 106);
        };
        const drawRankMetricCard = ({ x, y, w, accent, detailColor }) => {
          fillRounded(x, y, w, metricHeight, 18, "#17182a", "#2a2c45");
          fillRounded(x, y, 5, metricHeight, 3, accent);
          drawLabel("Club rank", x + 108, y + 20);

          const rankText = report.rankValue == null ? "—" : Number(report.rankValue).toLocaleString();
          const rankDetail = report.rankChange == null
            ? "Unavailable"
            : report.rankChange > 0
              ? `▲${Math.abs(report.rankChange).toLocaleString()} today`
              : report.rankChange < 0
                ? `▼${Math.abs(report.rankChange).toLocaleString()} today`
                : "No change";
          const rankIconSize = 64;
          const iconX = x + 24;
          const valueX = x + 108;
          if (rankIconImage) {
            ctx.drawImage(rankIconImage, iconX, y + 42, rankIconSize, rankIconSize);
          }
          setFont(850, 48);
          ctx.fillStyle = "#f8fafc";
          ctx.fillText(rankText, valueX, y + 43);

          setFont(700, 17);
          ctx.fillStyle = detailColor;
          ctx.fillText(fitText(rankDetail, w - 130), valueX, y + 111);
        };

        const background = ctx.createLinearGradient(0, 0, width, height);
        background.addColorStop(0, "#090a14");
        background.addColorStop(0.55, "#0d0d1b");
        background.addColorStop(1, "#111225");
        ctx.fillStyle = background;
        ctx.fillRect(0, 0, width, height);

        const glow = ctx.createRadialGradient(width - 140, 80, 0, width - 140, 80, 380);
        glow.addColorStop(0, `${tc.bar}42`);
        glow.addColorStop(1, "#00000000");
        ctx.fillStyle = glow;
        ctx.fillRect(0, 0, width, 520);

        let y = outerPadding;
        const headerIconSize = 84;
        if (tierIconImage) {
          ctx.drawImage(tierIconImage, outerPadding, y + 5, headerIconSize, headerIconSize);
        } else {
          fillRounded(outerPadding, y + 5, headerIconSize, headerIconSize, 22, tc.bar, tc.border);
          setFont(900, 26);
          ctx.fillStyle = "#ffffff";
          ctx.textAlign = "center";
          ctx.fillText(club.tier, outerPadding + (headerIconSize / 2), y + 32);
          ctx.textAlign = "left";
        }

        ctx.textAlign = "center";
        drawLabel("Dominator Network · Daily Report", width / 2, y + 4, tc.text);
        setFont(850, 42);
        ctx.fillStyle = "#f8fafc";
        ctx.fillText(fitText(club.name, width - 360), width / 2, y + 31);
        setFont(600, 15);
        ctx.fillStyle = "#a9adc2";
        ctx.fillText(
          fitText(`${report.dateLabel}  ·  ${report.dayLabel}  ·  ${report.sourceLabel}  ·  ${report.pingLabel}  ·  ${report.activeLabel}  ·  Target ${report.targetLabel}`, width - 250),
          width / 2,
          y + 91
        );
        ctx.textAlign = "left";

        y += headerHeight + sectionGap;
        const metricsWidth = width - (outerPadding * 2);
        const rankCardWidth = 298;
        const cardWidth = (metricsWidth - rankCardWidth - (metricGap * 3)) / 3;
        const rankAccent = report.rankChange > 0 ? "#34d399" : report.rankChange < 0 ? "#f87171" : "#8187a5";
        const rankDetailColor = report.rankChange > 0 ? "#65e5ad" : report.rankChange < 0 ? "#ff9292" : "#a9adc2";
        drawRankMetricCard({ x: outerPadding, y, w: rankCardWidth, accent: rankAccent, detailColor: rankDetailColor });
        const firstMetricX = outerPadding + rankCardWidth + metricGap;
        drawMetricCard({ x: firstMetricX, y, w: cardWidth, label: "Today's gain", value: report.dailyLabel, detail: "Today total", accent: "#60a5fa" });
        drawMetricCard({ x: firstMetricX + cardWidth + metricGap, y, w: cardWidth, label: "Month gain", value: report.monthLabel, detail: "Month to date", accent: tc.text });
        drawMetricCard({ x: firstMetricX + ((cardWidth + metricGap) * 2), y, w: cardWidth, label: "Vs pace", value: report.paceLabel, detail: report.pacePositive ? "Ahead of pace" : "Behind pace", accent: report.pacePositive ? "#34d399" : "#f87171", detailColor: report.pacePositive ? "#65e5ad" : "#ff9292" });

        y += metricHeight + sectionGap;
        fillRounded(outerPadding, y, metricsWidth, statusHeight, 16, "#141526", "#282a42");
        const statusCenterY = y + (statusHeight / 2);
        ctx.textBaseline = "middle";
        drawLabel("Member health", outerPadding + 22, statusCenterY);
        const statusItems = [
          { label: "ON TRACK", value: report.onTrack, color: "#34d399" },
          { label: "BEHIND", value: report.behind, color: "#fbbf24" },
          { label: "CRITICAL", value: report.critical, color: "#f87171" },
        ];
        const healthLabelWidth = 220;
        const healthGroupWidth = (metricsWidth - healthLabelWidth) / statusItems.length;
        statusItems.forEach((item, index) => {
          const groupCenterX = outerPadding + healthLabelWidth + (healthGroupWidth * (index + 0.5));
          const x = groupCenterX - 60;
          ctx.fillStyle = item.color;
          ctx.beginPath();
          ctx.arc(x, statusCenterY, 7, 0, Math.PI * 2);
          ctx.fill();
          setFont(800, 32);
          ctx.fillStyle = item.color;
          ctx.textAlign = "right";
          ctx.fillText(String(item.value), x + 62, statusCenterY);
          setFont(700, 16);
          ctx.fillStyle = "#9297af";
          ctx.textAlign = "left";
          ctx.fillText(item.label, x + 75, statusCenterY);
        });
        ctx.textAlign = "left";
        ctx.textBaseline = "top";

        y += statusHeight + sectionGap;
        const statusColumnWidth = 142;
        const numericGap = 24;
        const numericLeft = outerPadding + 420 + statusColumnWidth + 44;
        const numericRight = width - outerPadding - 22;
        const numericColumnWidth = (numericRight - numericLeft - (numericGap * 2)) / 3;
        const column = {
          member: outerPadding + 22,
          status: outerPadding + 420,
          statusCenter: outerPadding + 420 + (statusColumnWidth / 2),
          dailyRight: numericLeft + numericColumnWidth,
          monthRight: numericLeft + (numericColumnWidth * 2) + numericGap,
          paceRight: numericRight,
        };
        fillRounded(outerPadding, y, metricsWidth, tableHeaderHeight, 15, "#1a1b2e", "#2c2e48");
        ctx.textBaseline = "middle";
        const tableHeaderCenterY = y + (tableHeaderHeight / 2);
        drawLabel("Member", column.member, tableHeaderCenterY);
        ctx.textAlign = "center";
        drawLabel("Status", column.statusCenter, tableHeaderCenterY);
        ctx.textAlign = "right";
        drawLabel("Today", column.dailyRight, tableHeaderCenterY);
        drawLabel("Month", column.monthRight, tableHeaderCenterY);
        drawLabel("Vs pace", column.paceRight, tableHeaderCenterY);
        ctx.textAlign = "left";
        y += tableHeaderHeight;

        exportData.tableRows.forEach((row, index) => {
          const status = getDisplayStatusMeta(row.statusKey);
          const rowFill = index % 2 === 0 ? "#111221" : "#0d0e1a";
          const rowCenterY = y + (rowHeight / 2);
          ctx.fillStyle = rowFill;
          ctx.fillRect(outerPadding, y, metricsWidth, rowHeight);
          ctx.fillStyle = status.color;
          ctx.fillRect(outerPadding, y, 4, rowHeight);

          setFont(700, 28);
          ctx.fillStyle = "#eef0f8";
          ctx.fillText(fitText(row.name, 360), column.member, rowCenterY);

          fillRounded(column.status, y + ((rowHeight - 36) / 2), statusColumnWidth, 36, 18, status.bg, status.border);
          setFont(750, 18);
          ctx.fillStyle = status.color;
          ctx.textAlign = "center";
          ctx.fillText(status.label.toUpperCase(), column.statusCenter, rowCenterY);

          const mono = "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";
          setFont(700, 27, mono);
          ctx.fillStyle = "#d8dbea";
          ctx.textAlign = "right";
          ctx.fillText(fmtSigned(row.dailyGain), column.dailyRight, rowCenterY);
          ctx.fillText(fmtSigned(row.monthlyGain), column.monthRight, rowCenterY);
          ctx.fillStyle = hasComparisonData ? (row.paceDelta >= 0 ? "#65e5ad" : "#ff9292") : "#9ca3af";
          ctx.fillText(hasComparisonData ? fmtSigned(row.paceDelta) : "—", column.paceRight, rowCenterY);
          ctx.textAlign = "left";
          y += rowHeight;
        });

        ctx.textBaseline = "top";

        ctx.strokeStyle = "#292b43";
        ctx.beginPath();
        ctx.moveTo(outerPadding, y);
        ctx.lineTo(width - outerPadding, y);
        ctx.stroke();

        setFont(700, 17);
        ctx.fillStyle = "#858aa3";
        ctx.fillText("Dominator Network Tracker", outerPadding, y + 28);
        ctx.textAlign = "right";
        ctx.fillText(`${report.sourceLabel} · ${report.dateLabel}`, width - outerPadding, y + 28);
        ctx.textAlign = "left";

        return await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
      }

      async function renderAnimatedInsightStory(exportData = getDiscordExportData()) {
        const report = exportData.reportMeta;
        if (!report || !exportData.tableRows.length) return null;
        if (typeof window.GIF !== "function") throw new Error("The GIF encoder did not load. Refresh the page and try again.");

        if (document.fonts?.ready) {
          try { await document.fonts.ready; } catch (_) {}
        }

        const width = 960;
        const height = 540;
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        if (!ctx) return null;
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";

        const loadCanvasImage = (url) => new Promise((resolve) => {
          if (!url) return resolve(null);
          const image = new Image();
          image.onload = () => resolve(image);
          image.onerror = () => resolve(null);
          image.src = url;
        });
        const stableAnimationHash = (value) => {
          let hash = 2166136261;
          for (const character of String(value || "")) {
            hash ^= character.charCodeAt(0);
            hash = Math.imul(hash, 16777619);
          }
          return hash >>> 0;
        };
        const poseSet = (slug) => {
          const root = `./assets/images/animation-hosts/${slug}-`;
          return {
            neutral: `${root}neutral.webp`,
            performance: `${root}celebrate.webp`,
            performanceTalk: `${root}talk.webp`,
            attention: `${root}neutral.webp`,
            attentionTalk: `${root}talk.webp`,
            forecast: `${root}neutral.webp`,
            forecastTalk: `${root}talk.webp`,
            reveal: `${root}celebrate.webp`,
            revealTalk: `${root}talk.webp`,
            dash: `${root}dash.webp`,
          };
        };
        const animationHostCatalog = [
          {
            slug: "gentildonna",
            name: "Gentildonna",
            accent: "#f4c45f",
            assets: {
              neutral: "./assets/images/animation-hosts/gentildonna.png",
              performance: "./assets/images/animation-hosts/gentildonna-celebrate.png",
              performanceTalk: "./assets/images/animation-hosts/gentildonna-celebrate-talk.png",
              attention: "./assets/images/animation-hosts/gentildonna-focus.png",
              attentionTalk: "./assets/images/animation-hosts/gentildonna-focus-talk.png",
              forecast: "./assets/images/animation-hosts/gentildonna-strategic.png",
              forecastTalk: "./assets/images/animation-hosts/gentildonna-strategic-talk.png",
              reveal: "./assets/images/animation-hosts/gentildonna-celebrate.png",
              revealTalk: "./assets/images/animation-hosts/gentildonna-celebrate-talk.png",
              dash: "./assets/images/animation-hosts/gentildonna-dash.png",
            },
            dialogue: {
              performance: ["Power confirmed.", "Read the rhythm!"],
              attention: ["Eyes on the gaps.", "No weakness ignored."],
              forecast: ["Victory takes shape.", "The crown is in reach."],
            },
          },
          {
            slug: "symboli-rudolf",
            name: "Symboli Rudolf",
            accent: "#d4af37",
            assets: poseSet("symboli-rudolf"),
            dialogue: {
              performance: ["The course is set.", "A worthy result."],
              attention: ["Discipline decides.", "Correct the course."],
              forecast: ["Advance with purpose.", "The future is ordered."],
            },
          },
          {
            slug: "narita-top-road",
            name: "Narita Top Road",
            accent: "#a78bfa",
            assets: poseSet("narita-top-road"),
            dialogue: {
              performance: ["We kept pushing!", "Great work today!"],
              attention: ["We can catch up!", "One step at a time!"],
              forecast: ["Let's meet the goal!", "I believe in everyone!"],
            },
          },
          {
            slug: "tm-opera-o",
            name: "T.M. Opera O",
            accent: "#f97316",
            assets: poseSet("tm-opera-o"),
            dialogue: {
              performance: ["Behold today's act!", "A brilliant showing!"],
              attention: ["The drama rises!", "Rewrite this scene!"],
              forecast: ["The finale awaits!", "Onward to glory!"],
            },
          },
          {
            slug: "admire-vega",
            name: "Admire Vega",
            accent: "#818cf8",
            assets: poseSet("admire-vega"),
            dialogue: {
              performance: ["The result is clear.", "Keep your focus."],
              attention: ["Face the gap.", "No wasted motion."],
              forecast: ["Follow that star.", "The path is visible."],
            },
          },
          {
            slug: "oguri-cap",
            name: "Oguri Cap",
            accent: "#60a5fa",
            assets: poseSet("oguri-cap"),
            dialogue: {
              performance: ["Good work.", "A solid result."],
              attention: ["Close the gap.", "We keep moving."],
              forecast: ["The goal is ahead.", "Steady progress."],
            },
          },
          {
            slug: "mejiro-palmer",
            name: "Mejiro Palmer",
            accent: "#34d399",
            assets: poseSet("mejiro-palmer"),
            dialogue: {
              performance: ["Nice pace today!", "That's the vibe!"],
              attention: ["No panic—reset!", "We've got this!"],
              forecast: ["Keep it rolling!", "The route looks good!"],
            },
          },
        ];
        const hostSeed = `${club.id || club.name}:${formatLocalDateKey(dataDate)}`;
        const normalizedClubName = String(club.name || "")
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/(^-|-$)/g, "");
        const isDominantH = String(club.id || "") === "278155676" || normalizedClubName === "dominant-h";
        const eligibleAnimationHosts = isDominantH
          ? animationHostCatalog.filter((host) => ["admire-vega", "mejiro-palmer"].includes(host.slug))
          : animationHostCatalog;
        const normalizedHostOverride = String(club.animationHost || "")
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/(^-|-$)/g, "");
        const selectedAnimationHost = eligibleAnimationHosts.find((host) => host.slug === normalizedHostOverride)
          || eligibleAnimationHosts[stableAnimationHash(hostSeed) % eligibleAnimationHosts.length];
        const hostLine = (kind) => {
          const choices = selectedAnimationHost.dialogue[kind] || ["Let's begin!"];
          return choices[stableAnimationHash(`${hostSeed}:${selectedAnimationHost.slug}:${kind}`) % choices.length];
        };
        const selectedAssets = selectedAnimationHost.assets;
        const [tierIcon, animationHost, celebrationHost, celebrationTalkHost, focusHost, focusTalkHost, strategicHost, strategicTalkHost, revealHost, revealTalkHost, dashHost] = await Promise.all([
          loadCanvasImage(getRankIconUrl(club.tier, viewRankingConfig, viewRankIconPath)),
          loadCanvasImage(selectedAssets.neutral),
          loadCanvasImage(selectedAssets.performance),
          loadCanvasImage(selectedAssets.performanceTalk),
          loadCanvasImage(selectedAssets.attention),
          loadCanvasImage(selectedAssets.attentionTalk),
          loadCanvasImage(selectedAssets.forecast),
          loadCanvasImage(selectedAssets.forecastTalk),
          loadCanvasImage(selectedAssets.reveal),
          loadCanvasImage(selectedAssets.revealTalk),
          loadCanvasImage(selectedAssets.dash),
        ]);
        const hostVariantSets = {
          performance: [celebrationHost || animationHost, celebrationTalkHost || celebrationHost || animationHost].filter(Boolean),
          attention: [focusHost || animationHost, focusTalkHost || focusHost || animationHost].filter(Boolean),
          forecast: [strategicHost || animationHost, strategicTalkHost || strategicHost || animationHost].filter(Boolean),
        };

        const rows = exportData.tableRows;
        const activeCount = rows.length;
        const history = (Array.isArray(report.dailyHistory) ? report.dailyHistory : [])
          .map((value) => Number(value || 0))
          .filter((value) => Number.isFinite(value));
        const recentSeven = history.slice(-7);
        const recentThree = history.slice(-3);
        const average = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
        const avgSeven = average(recentSeven);
        const avgThree = average(recentThree);
        const variance = recentSeven.length
          ? recentSeven.reduce((sum, value) => sum + Math.pow(value - avgSeven, 2), 0) / recentSeven.length
          : 0;
        const consistencyScore = avgSeven > 0 ? Math.max(0, Math.min(100, Math.round(100 - ((Math.sqrt(variance) / avgSeven) * 100)))) : 0;
        const consistencyLabel = consistencyScore >= 82 ? "Very steady" : consistencyScore >= 65 ? "Mostly steady" : "Uneven";
        const targetValue = Number(report.targetValue || (Number(club.target || 0) * activeCount));
        const dailyTarget = targetValue / Math.max(1, dim);
        const currentDaily = Number(report.dailyValue || 0);
        const previousDaily = Number(report.previousDailyValue || 0);
        const acceleration = report.dailyTrendDelta == null ? currentDaily - previousDaily : Number(report.dailyTrendDelta || 0);
        const accelerationPercent = previousDaily > 0 ? (acceleration / previousDaily) * 100 : null;
        const dailyPaceRatio = dailyTarget > 0 ? currentDaily / dailyTarget : 0;
        const paceDifference = currentDaily - dailyTarget;
        const acceleratingMembers = rows.filter((row) => Number(row.dailyGain || 0) > Number(row.rolling3DayAvg || 0)).length;

        const belowPaceRows = rows
          .filter((row) => Number(row.paceDelta || 0) < 0)
          .sort((a, b) => Number(a.paceDelta || 0) - Number(b.paceDelta || 0));
        const recoveryLoad = belowPaceRows.reduce((sum, row) => sum + Math.max(0, -Number(row.paceDelta || 0)), 0);
        const remainingDays = Math.max(0, Number(report.daysRemaining ?? (dim - today)));
        const recoveryDaily = remainingDays > 0 ? recoveryLoad / remainingDays : recoveryLoad;
        const stalledMembers = rows.filter((row) => Number(row.stagnantDays || 0) >= 2).length;

        const monthValue = Number(report.monthValue || 0);
        const projectedValue = Number(report.projectedValue || 0);
        const runRateProjection = monthValue + (avgThree * remainingDays);
        const recentFloor = recentThree.length ? Math.min(...recentThree) : 0;
        const recentCeiling = recentThree.length ? Math.max(...recentThree) : 0;
        const conservativeProjection = monthValue + (recentFloor * remainingDays);
        const stretchProjection = monthValue + (recentCeiling * remainingDays);
        const baseProjection = projectedValue > 0 ? projectedValue : runRateProjection;
        const forecastGap = baseProjection - targetValue;
        const requiredDaily = remainingDays > 0 ? Math.max(0, targetValue - monthValue) / remainingDays : 0;
        const bufferDays = avgThree > 0 ? forecastGap / avgThree : 0;

        const sectionChapters = [
          { kind: "performance", majorPage: 1, eyebrow: "TODAY'S PERFORMANCE", title: "Did we hit today's pace?", subtitle: "Club output compared with the daily pace needed for the monthly goal.", accent: "#60a5fa", bubble: hostLine("performance") },
          { kind: "attention", majorPage: 2, eyebrow: "MEMBER CHECK-IN", title: "Who needs attention?", subtitle: "Every member below elapsed monthly pace, ordered by the largest gap first.", accent: "#fbbf24", bubble: hostLine("attention") },
          { kind: "forecast", majorPage: 3, eyebrow: "MONTH-END OUTLOOK", title: "Where are we heading?", subtitle: "A forecast range based on the club's latest daily output.", accent: "#a78bfa", bubble: hostLine("forecast") },
        ];
        const attentionPageRows = belowPaceRows.length
          ? Array.from({ length: Math.ceil(belowPaceRows.length / 3) }, (_, index) => belowPaceRows.slice(index * 3, (index * 3) + 3))
          : [[]];
        const storyScenes = [
          sectionChapters[0],
          ...attentionPageRows.map((pageRows, index) => ({
            ...sectionChapters[1],
            rows: pageRows,
            memberStartIndex: index * 3,
            subPage: index + 1,
            subPageCount: attentionPageRows.length,
          })),
          sectionChapters[2],
        ];

        const clamp01 = (value) => Math.max(0, Math.min(1, value));
        const smoothstep = (value) => {
          const clamped = clamp01(value);
          return clamped * clamped * (3 - (2 * clamped));
        };
        const lerp = (from, to, amount) => from + ((to - from) * amount);
        const frameDelay = 90;
        const frameSeconds = (frame) => (frame * frameDelay) / 1000;
        const alpha = (hex, opacity) => {
          const safeOpacity = Math.max(0, Math.min(255, Math.round(opacity * 255))).toString(16).padStart(2, "0");
          return hex + safeOpacity;
        };
        const roundedRect = (x, y, w, h, radius) => {
          ctx.beginPath();
          ctx.moveTo(x + radius, y);
          ctx.lineTo(x + w - radius, y);
          ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
          ctx.lineTo(x + w, y + h - radius);
          ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
          ctx.lineTo(x + radius, y + h);
          ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
          ctx.lineTo(x, y + radius);
          ctx.quadraticCurveTo(x, y, x + radius, y);
          ctx.closePath();
        };
        const fillRounded = (x, y, w, h, radius, fill, stroke = null) => {
          roundedRect(x, y, w, h, radius);
          ctx.fillStyle = fill;
          ctx.fill();
          if (stroke) {
            ctx.strokeStyle = stroke;
            ctx.lineWidth = 1;
            ctx.stroke();
          }
        };
        const setFont = (weight, size, family = "Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif") => {
          ctx.font = weight + " " + size + "px " + family;
        };
        const fitText = (value, maxWidth) => {
          const text = String(value ?? "");
          if (ctx.measureText(text).width <= maxWidth) return text;
          let output = text;
          while (output.length > 1 && ctx.measureText(output + "…").width > maxWidth) output = output.slice(0, -1);
          return output + "…";
        };
        const drawLabel = (label, x, y, color = "#8f93ad", align = "left") => {
          setFont(780, 12);
          ctx.fillStyle = color;
          ctx.textAlign = align;
          ctx.fillText(String(label).toUpperCase(), x, y);
          ctx.textAlign = "left";
        };
        const drawPanel = (x, y, w, h, accent = "#2b2d47") => {
          fillRounded(x, y, w, h, 17, "#121321", "#292b43");
          fillRounded(x, y, 5, h, 3, accent);
        };
        const drawSmallCard = (x, y, w, label, value, detail, accent, valueColor = "#f8fafc") => {
          fillRounded(x, y, w, 97, 14, "#17182a", "#2b2d47");
          drawLabel(label, x + 14, y + 14, accent);
          setFont(850, 23);
          ctx.fillStyle = valueColor;
          ctx.fillText(fitText(value, w - 28), x + 14, y + 35);
          setFont(630, 10);
          ctx.fillStyle = "#9297af";
          ctx.fillText(fitText(detail, w - 28), x + 14, y + 72);
        };
        const drawHeader = (chapter, frame) => {
          if (tierIcon) ctx.drawImage(tierIcon, 32, 17, 72, 72);
          else {
            fillRounded(32, 17, 72, 72, 18, tc.bar, tc.border);
            setFont(900, 22);
            ctx.fillStyle = "#fff";
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText(club.tier, 68, 53);
            ctx.textAlign = "left";
            ctx.textBaseline = "top";
          }

          drawLabel("DOMINATOR NETWORK · DAILY CLUB STORY", 118, 15, chapter.accent);
          setFont(900, 32);
          ctx.fillStyle = "#f8fafc";
          ctx.fillText(fitText(club.name, 500), 118, 32);
          setFont(650, 13);
          ctx.fillStyle = "#a8acc1";
          ctx.fillText(report.dateLabel + "  ·  " + report.dayLabel + "  ·  " + report.sourceLabel, 118, 72);

          const hostVariants = hostVariantSets[chapter.kind] || [animationHost].filter(Boolean);
          const time = frameSeconds(frame);
          const speechCycle = Math.floor(time / 0.78) % 8;
          const chapterHost = hostVariants[speechCycle >= 2 && speechCycle <= 4 ? 1 : 0] || hostVariants[0] || animationHost;
          if (chapterHost) {
            const bob = Math.sin((time * 1.46) + (chapter.majorPage * 1.7)) * 3.5;
            const sway = Math.sin((time * 0.73) + chapter.majorPage) * 0.035;
            const pulse = 1 + (Math.sin((time * 1.19) + chapter.majorPage) * 0.022);
            const hostHeight = 98;
            const hostWidth = hostHeight * (chapterHost.width / chapterHost.height);
            fillRounded(646, 22 + (bob * 0.45), 194, 52, 20, alpha(selectedAnimationHost.accent, 0.15), alpha(selectedAnimationHost.accent, 0.58));
            drawLabel(selectedAnimationHost.name, 743, 29 + (bob * 0.45), selectedAnimationHost.accent, "center");
            setFont(750, 11);
            ctx.fillStyle = "#eef0f8";
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            const speechDots = speechCycle < 5 ? ".".repeat((Math.floor(time / 0.52) % 3) + 1) : "";
            ctx.fillText(fitText(chapter.bubble + speechDots, 168), 743, 56 + (bob * 0.45));
            ctx.textAlign = "left";
            ctx.textBaseline = "top";
            ctx.save();
            ctx.translate(884 + (hostWidth / 2), 50 + bob);
            ctx.rotate(sway);
            ctx.scale(pulse, pulse);
            ctx.drawImage(chapterHost, -hostWidth / 2, -hostHeight / 2, hostWidth, hostHeight);
            ctx.restore();
          }

          ctx.strokeStyle = "#25273d";
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(32, 105);
          ctx.lineTo(928, 105);
          ctx.stroke();
        };
        const drawSceneIntro = (chapter) => {
          drawLabel(chapter.eyebrow, 32, 122, chapter.accent);
          setFont(900, 28);
          ctx.fillStyle = "#f8fafc";
          ctx.fillText(fitText(chapter.title, 690), 32, 143);
          setFont(640, 13);
          ctx.fillStyle = "#a7abc0";
          ctx.fillText(fitText(chapter.subtitle, 690), 32, 181);

          sectionChapters.forEach((entry, index) => {
            const x = 772 + (index * 52);
            fillRounded(x, 145, 42, 6, 3, entry.majorPage === chapter.majorPage ? entry.accent : "#292b43");
          });
          setFont(750, 11);
          ctx.fillStyle = chapter.accent;
          ctx.textAlign = "right";
          const subPageLabel = chapter.kind === "attention" && chapter.subPageCount > 1
            ? ` · FOCUS ${chapter.subPage}/${chapter.subPageCount}`
            : "";
          ctx.fillText(chapter.majorPage + " OF 3" + subPageLabel, 928, 166);
          ctx.textAlign = "left";
        };
        const drawPerformanceScene = () => {
          const accent = sectionChapters[0].accent;
          drawPanel(32, 218, 330, 267, accent);
          drawLabel("TODAY'S CLUB TOTAL", 54, 239, accent);
          setFont(900, 42);
          ctx.fillStyle = "#f8fafc";
          ctx.fillText(fmt(currentDaily), 54, 264);
          setFont(650, 13);
          ctx.fillStyle = "#9ca1b8";
          ctx.fillText("Daily pace needed: " + fmt(dailyTarget), 54, 316);

          const barWidth = 286;
          fillRounded(54, 345, barWidth, 14, 7, "#272940");
          fillRounded(54, 345, Math.max(8, barWidth * Math.min(1, dailyPaceRatio)), 14, 7, dailyPaceRatio >= 1 ? "#34d399" : "#60a5fa");
          setFont(850, 18);
          ctx.fillStyle = dailyPaceRatio >= 1 ? "#65e5ad" : "#fbbf24";
          ctx.fillText(Math.round(dailyPaceRatio * 100) + "% of today's needed pace", 54, 373);

          fillRounded(54, 400, 286, 68, 12, dailyPaceRatio >= 1 ? "#34d39916" : "#fbbf2416", dailyPaceRatio >= 1 ? "#34d39966" : "#fbbf2466");
          drawLabel(dailyPaceRatio >= 1 ? "AHEAD TODAY" : "STILL NEEDED TODAY", 70, 412, dailyPaceRatio >= 1 ? "#34d399" : "#fbbf24");
          setFont(850, 22);
          ctx.fillStyle = dailyPaceRatio >= 1 ? "#65e5ad" : "#ffcf54";
          ctx.fillText(fmt(Math.abs(paceDifference)), 70, 437);

          drawPanel(380, 218, 548, 158, accent);
          drawLabel("LAST 7 DAYS", 400, 235, accent);
          setFont(620, 11);
          ctx.fillStyle = "#858aa3";
          ctx.textAlign = "right";
          ctx.fillText("Dashed line = daily pace needed", 908, 235);
          ctx.textAlign = "left";

          const values = recentSeven.length ? recentSeven : [0];
          const plotX = 404;
          const plotY = 263;
          const plotW = 500;
          const plotH = 80;
          const maxValue = Math.max(dailyTarget, ...values, 1);
          for (let line = 0; line < 3; line += 1) {
            const lineY = plotY + ((plotH / 2) * line);
            ctx.strokeStyle = "#25273d";
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(plotX, lineY);
            ctx.lineTo(plotX + plotW, lineY);
            ctx.stroke();
          }
          const targetY = plotY + plotH - ((dailyTarget / maxValue) * plotH);
          ctx.save();
          ctx.setLineDash([6, 5]);
          ctx.strokeStyle = "#fbbf24aa";
          ctx.beginPath();
          ctx.moveTo(plotX, targetY);
          ctx.lineTo(plotX + plotW, targetY);
          ctx.stroke();
          ctx.restore();

          const points = values.map((value, index) => ({
            x: values.length === 1 ? plotX + (plotW / 2) : plotX + ((plotW / (values.length - 1)) * index),
            y: plotY + plotH - ((value / maxValue) * plotH),
          }));
          ctx.strokeStyle = "#78b7ff";
          ctx.lineWidth = 4;
          ctx.lineJoin = "round";
          ctx.beginPath();
          points.forEach((point, index) => {
            if (index === 0) ctx.moveTo(point.x, point.y);
            else ctx.lineTo(point.x, point.y);
          });
          ctx.stroke();
          points.forEach((point, index) => {
            ctx.fillStyle = index === points.length - 1 ? "#f8fafc" : accent;
            ctx.beginPath();
            ctx.arc(point.x, point.y, index === points.length - 1 ? 5 : 3.5, 0, Math.PI * 2);
            ctx.fill();
            setFont(650, 9);
            ctx.fillStyle = "#858aa3";
            ctx.textAlign = "center";
            ctx.fillText("D" + (today - values.length + index + 1), point.x, 350);
          });
          ctx.textAlign = "left";

          const cardWidth = 176;
          drawSmallCard(380, 388, cardWidth, "VS YESTERDAY", accelerationPercent == null ? "—" : (accelerationPercent >= 0 ? "+" : "") + accelerationPercent.toFixed(1) + "%", fmtSigned(acceleration) + " change", acceleration >= 0 ? "#34d399" : "#f87171", acceleration >= 0 ? "#65e5ad" : "#ff9292");
          drawSmallCard(566, 388, cardWidth, "MEMBERS IMPROVING", acceleratingMembers + " / " + activeCount, "Above their 3-day average", "#60a5fa");
          drawSmallCard(752, 388, cardWidth, "OUTPUT CONSISTENCY", consistencyLabel, consistencyScore + "/100 steadiness", "#a78bfa", "#d8b4fe");
        };
        const drawAttentionScene = (chapter) => {
          const accent = sectionChapters[1].accent;
          drawPanel(32, 218, 896, 76, accent);
          const summaryItems = [
            { value: String(belowPaceRows.length), label: "MEMBERS BELOW PACE" },
            { value: fmt(recoveryDaily), label: "EXTRA CLUB OUTPUT / DAY" },
            { value: String(stalledMembers), label: "QUIET FOR 2+ DAYS" },
          ];
          summaryItems.forEach((item, index) => {
            const left = 52 + (index * 294);
            if (index > 0) {
              ctx.fillStyle = "#2b2d47";
              ctx.fillRect(left - 18, 234, 1, 44);
            }
            setFont(900, 28);
            ctx.fillStyle = index === 2 && stalledMembers > 0 ? "#ffcf54" : "#f8fafc";
            ctx.fillText(item.value, left, 231);
            drawLabel(item.label, left, 267, accent);
          });

          drawPanel(32, 310, 896, 175, accent);
          drawLabel("TODAY'S PRIORITY MEMBERS", 52, 324, accent);
          setFont(620, 10);
          ctx.fillStyle = "#8388a0";
          ctx.textAlign = "right";
          ctx.fillText(belowPaceRows.length ? "Sorted by largest pace gap" : "Everyone is currently at pace", 908, 324);
          ctx.textAlign = "left";

          const columns = [
            { label: "MEMBER", x: 70, align: "left" },
            { label: "GAP VS PACE", x: 398, align: "center" },
            { label: "RECENT DAILY AVG", x: 610, align: "center" },
            { label: "OUTLOOK", x: 828, align: "center" },
          ];
          columns.forEach((column) => {
            setFont(800, 10);
            ctx.fillStyle = "#747991";
            ctx.textAlign = column.align;
            ctx.fillText(column.label, column.x, 345);
          });
          ctx.textAlign = "left";

          (chapter.rows || []).forEach((row, index) => {
            const rowY = 365 + (index * 39);
            const deficit = Math.max(0, -Number(row.paceDelta || 0));
            const quietDays = Number(row.stagnantDays || 0);
            const color = deficit > 0 ? "#fbbf24" : "#34d399";
            fillRounded(52, rowY, 856, 34, 10, index % 2 === 0 ? "#17182a" : "#141522", "#272940");
            fillRounded(52, rowY, 4, 34, 2, color);
            ctx.textBaseline = "middle";

            fillRounded(66, rowY + 7, 20, 20, 10, alpha(color, 0.16), alpha(color, 0.5));
            setFont(800, 10);
            ctx.fillStyle = color;
            ctx.textAlign = "center";
            ctx.fillText(String((chapter.memberStartIndex || 0) + index + 1), 76, rowY + 17);

            setFont(820, 15);
            ctx.fillStyle = "#eef0f8";
            ctx.textAlign = "left";
            ctx.fillText(fitText(row.name, 230), 96, rowY + 17);

            setFont(800, 14);
            ctx.fillStyle = deficit > 0 ? "#ffcf54" : "#65e5ad";
            ctx.textAlign = "center";
            ctx.fillText(deficit > 0 ? "-" + fmt(deficit) : "AT PACE", 398, rowY + 17);

            ctx.fillStyle = "#d8dbea";
            ctx.fillText(fmt(Number(row.rolling3DayAvg || 0)) + " / day", 610, rowY + 17);

            const outlook = quietDays >= 2
              ? quietDays + "D QUIET"
              : row.daysToTarget == null
                ? "NEW PACE NEEDED"
                : row.daysToTarget + "D TO QUOTA";
            ctx.fillStyle = quietDays >= 2 ? "#ffcf54" : "#aeb3c8";
            ctx.fillText(outlook, 828, rowY + 17);

            ctx.textAlign = "left";
            ctx.textBaseline = "top";
          });
          if (!(chapter.rows || []).length) {
            setFont(850, 21);
            ctx.fillStyle = "#65e5ad";
            ctx.textAlign = "center";
            ctx.fillText("EVERY MEMBER IS CURRENTLY ON PACE", 480, 392);
            setFont(650, 12);
            ctx.fillStyle = "#9ca1b8";
            ctx.fillText("No member follow-up is needed today.", 480, 425);
            ctx.textAlign = "left";
          }
        };
        const drawForecastScene = () => {
          const accent = sectionChapters[2].accent;
          drawPanel(32, 218, 330, 267, accent);
          drawLabel("PROJECTED FINISH VS TARGET", 54, 239, accent);
          setFont(900, 40);
          ctx.fillStyle = forecastGap >= 0 ? "#65e5ad" : "#ff9292";
          ctx.fillText(fmtSigned(forecastGap), 54, 264);
          setFont(700, 13);
          ctx.fillStyle = forecastGap >= 0 ? "#34d399" : "#f87171";
          ctx.fillText(forecastGap >= 0 ? "Projected above target" : "Projected below target", 54, 313);

          fillRounded(54, 346, 286, 62, 12, "#17182a", "#2b2d47");
          drawLabel("CURRENT FORECAST", 197, 359, "#a78bfa", "center");
          setFont(850, 24);
          ctx.fillStyle = "#f8fafc";
          ctx.textAlign = "center";
          ctx.fillText(fmt(baseProjection), 197, 379);
          ctx.textAlign = "left";

          setFont(650, 12);
          ctx.fillStyle = "#969bb2";
          ctx.fillText("Monthly target: " + fmt(targetValue), 54, 426);
          ctx.fillText("Current month total: " + fmt(monthValue), 54, 450);

          drawPanel(380, 218, 548, 170, accent);
          drawLabel("POSSIBLE MONTH-END RANGE", 400, 235, accent);
          setFont(620, 11);
          ctx.fillStyle = "#858aa3";
          ctx.textAlign = "right";
          ctx.fillText("Based on the latest 3 daily totals", 908, 235);
          ctx.textAlign = "left";

          const scenarios = [
            { label: "Recent low repeats", value: conservativeProjection, color: "#fbbf24" },
            { label: "Current projection", value: baseProjection, color: "#a78bfa" },
            { label: "Recent high repeats", value: stretchProjection, color: "#34d399" },
          ];
          const chartMax = Math.max(targetValue, ...scenarios.map((entry) => entry.value), 1);
          scenarios.forEach((entry, index) => {
            const y = 270 + (index * 37);
            setFont(700, 11);
            ctx.fillStyle = "#aeb3c8";
            ctx.fillText(entry.label, 400, y);
            fillRounded(548, y + 1, 250, 12, 6, "#272940");
            fillRounded(548, y + 1, Math.max(8, 250 * (entry.value / chartMax)), 12, 6, alpha(entry.color, 0.85));
            const targetX = 548 + (250 * (targetValue / chartMax));
            ctx.fillStyle = "#f8fafc";
            ctx.fillRect(targetX - 1, y - 3, 2, 20);
            setFont(800, 12);
            ctx.fillStyle = entry.color;
            ctx.textAlign = "right";
            ctx.fillText(fmt(entry.value), 908, y - 1);
            ctx.textAlign = "left";
          });
          setFont(650, 9);
          ctx.fillStyle = "#d8dbea";
          ctx.textAlign = "right";
          ctx.fillText("WHITE MARKER = TARGET " + fmt(targetValue), 908, 367);
          ctx.textAlign = "left";

          const cardWidth = 176;
          drawSmallCard(380, 400, cardWidth, "DAYS LEFT", String(remainingDays), "Days remaining this month", "#60a5fa");
          drawSmallCard(566, 400, cardWidth, "NEEDED FROM HERE", fmt(requiredDaily), "Club output needed per day", "#a78bfa");
          drawSmallCard(752, 400, cardWidth, "FORECAST BUFFER", (bufferDays >= 0 ? "+" : "") + bufferDays.toFixed(1) + " days", bufferDays >= 0 ? "Room above target pace" : "Recovery still needed", forecastGap >= 0 ? "#34d399" : "#f87171", forecastGap >= 0 ? "#65e5ad" : "#ff9292");
        };

        const drawStoryScene = (sceneIndex, frame, opacity = 1) => {
          const chapter = storyScenes[sceneIndex];
          ctx.save();
          ctx.globalAlpha = opacity;

          const background = ctx.createLinearGradient(0, 0, width, height);
          background.addColorStop(0, "#080914");
          background.addColorStop(0.58, "#0d0e1c");
          background.addColorStop(1, "#141126");
          ctx.fillStyle = background;
          ctx.fillRect(0, 0, width, height);

          const glow = ctx.createRadialGradient(width - 110, 45, 0, width - 110, 45, 420);
          glow.addColorStop(0, alpha(chapter.accent, 0.22));
          glow.addColorStop(1, "#00000000");
          ctx.fillStyle = glow;
          ctx.fillRect(0, 0, width, height);

          ctx.textBaseline = "top";
          ctx.textAlign = "left";
          drawHeader(chapter, frame);
          drawSceneIntro(chapter);
          if (chapter.kind === "performance") drawPerformanceScene();
          else if (chapter.kind === "attention") drawAttentionScene(chapter);
          else drawForecastScene();

          setFont(650, 10);
          ctx.fillStyle = "#737890";
          ctx.fillText("Dominator Network Tracker · Member Daily Story", 32, 516);
          ctx.textAlign = "right";
          const footerPage = chapter.kind === "attention" && chapter.subPageCount > 1
            ? `${chapter.majorPage}${String.fromCharCode(64 + chapter.subPage)}`
            : String(chapter.majorPage);
          ctx.fillText(footerPage + "/3  ·  " + chapter.eyebrow, 928, 516);
          ctx.textAlign = "left";
          ctx.restore();
        };

        const drawAcquisitionReveal = (progress, frame, visibility = 1) => {
          const time = frameSeconds(frame);
          const revealCycle = Math.floor(time / 0.78) % 7;
          const acquisitionHost = revealCycle >= 2 && revealCycle <= 4
            ? (revealTalkHost || revealHost || celebrationTalkHost || celebrationHost || animationHost)
            : (revealHost || celebrationHost || animationHost);
          if (!acquisitionHost || visibility <= 0.01) return;
          const reveal = smoothstep(progress);
          const entranceScale = lerp(0.56, 1, reveal);
          const lift = lerp(72, 0, reveal);
          const bounce = Math.sin(time * 1.85) * 3;
          const hostHeight = 350;
          const hostWidth = hostHeight * (acquisitionHost.width / acquisitionHost.height);

          ctx.save();
          ctx.globalAlpha = visibility;
          const spotlight = ctx.createRadialGradient(480, 264, 0, 480, 264, 330);
          spotlight.addColorStop(0, alpha("#fff7cf", 0.36 * reveal));
          spotlight.addColorStop(0.34, alpha(selectedAnimationHost.accent, 0.22 * reveal));
          spotlight.addColorStop(1, "#00000000");
          ctx.fillStyle = spotlight;
          ctx.fillRect(100, 0, 760, height);

          ctx.translate(480, 276 + lift + bounce);
          ctx.scale(entranceScale, entranceScale);
          for (let ray = 0; ray < 12; ray += 1) {
            const angle = ((Math.PI * 2) / 12) * ray + (time * 0.069);
            const inner = 118;
            const outer = 210 + ((ray % 2) * 34);
            ctx.strokeStyle = alpha(ray % 2 ? selectedAnimationHost.accent : "#ffffff", 0.2 * reveal);
            ctx.lineWidth = ray % 2 ? 3 : 2;
            ctx.beginPath();
            ctx.moveTo(Math.cos(angle) * inner, Math.sin(angle) * inner);
            ctx.lineTo(Math.cos(angle) * outer, Math.sin(angle) * outer);
            ctx.stroke();
          }
          ctx.drawImage(acquisitionHost, -hostWidth / 2, -hostHeight / 2, hostWidth, hostHeight);
          ctx.restore();

          ctx.save();
          ctx.globalAlpha = visibility * reveal;
          const plateY = 432 + (lift * 0.18);
          fillRounded(300, plateY, 360, 67, 18, "#11121ff2", alpha(selectedAnimationHost.accent, 0.72));
          drawLabel("TODAY'S UMA HOST", 480, plateY + 11, selectedAnimationHost.accent, "center");
          setFont(900, 28);
          ctx.fillStyle = "#f8fafc";
          ctx.textAlign = "center";
          ctx.fillText(fitText(selectedAnimationHost.name.toUpperCase(), 330), 480, plateY + 29);
          ctx.textAlign = "left";
          ctx.restore();
        };

        const drawStartingGate = (openAmount, frame) => {
          const time = frameSeconds(frame);
          const open = clamp01(openAmount);
          const doorTravel = 500 * open;
          const leftX = -doorTravel;
          const rightX = 460 + doorTravel;
          const shine = Math.sin(open * Math.PI);
          const leftGradient = ctx.createLinearGradient(leftX, 0, leftX + 500, 0);
          leftGradient.addColorStop(0, "#0a0b18");
          leftGradient.addColorStop(0.72, "#171a32");
          leftGradient.addColorStop(1, "#24213b");
          const rightGradient = ctx.createLinearGradient(rightX, 0, rightX + 500, 0);
          rightGradient.addColorStop(0, "#24213b");
          rightGradient.addColorStop(0.28, "#171a32");
          rightGradient.addColorStop(1, "#0a0b18");

          ctx.fillStyle = leftGradient;
          ctx.fillRect(leftX, 0, 500, height);
          ctx.fillStyle = rightGradient;
          ctx.fillRect(rightX, 0, 500, height);

          [leftX, rightX].forEach((doorX, doorIndex) => {
            ctx.strokeStyle = "#d8aa49";
            ctx.lineWidth = 3;
            ctx.strokeRect(doorX + 18, 18, 464, height - 36);
            ctx.strokeStyle = "#6f5730";
            ctx.lineWidth = 1;
            for (let panel = 1; panel < 4; panel += 1) {
              const panelX = doorX + (panel * 125);
              ctx.beginPath();
              ctx.moveTo(panelX, 21);
              ctx.lineTo(panelX, height - 21);
              ctx.stroke();
            }
            ctx.fillStyle = doorIndex === 0 ? "#f4c45f22" : "#60a5fa16";
            ctx.fillRect(doorX + 24, 24, 452, height - 48);
          });

          const seamLeft = leftX + 496;
          const seamRight = rightX;
          ctx.fillStyle = "#f4c45f";
          ctx.fillRect(seamLeft, 0, 4, height);
          ctx.fillRect(seamRight, 0, 4, height);

          if (open < 0.84) {
            const titleOpacity = 1 - (open / 0.84);
            ctx.save();
            ctx.globalAlpha = titleOpacity;
            const pulse = 1 + (Math.sin(time * 2.12) * 0.025);
            ctx.translate(width / 2, height / 2);
            ctx.scale(pulse, pulse);
            ctx.translate(-width / 2, -height / 2);
            if (tierIcon) ctx.drawImage(tierIcon, 425, 38, 110, 110);

            ctx.save();
            ctx.shadowColor = "#000000cc";
            ctx.shadowBlur = 24;
            ctx.shadowOffsetY = 8;
            const titlePanel = ctx.createLinearGradient(150, 160, 810, 334);
            titlePanel.addColorStop(0, "#080a17");
            titlePanel.addColorStop(0.5, "#101326");
            titlePanel.addColorStop(1, "#080a17");
            fillRounded(150, 160, 660, 174, 24, titlePanel, alpha(selectedAnimationHost.accent, 0.72));
            ctx.restore();
            fillRounded(174, 160, 612, 3, 2, selectedAnimationHost.accent);

            drawLabel("DOMINATOR NETWORK · TEN-GATE REVEAL", 480, 178, selectedAnimationHost.accent, "center");
            setFont(900, 37);
            ctx.fillStyle = "#f8fafc";
            ctx.textAlign = "center";
            ctx.fillText(fitText((club.name + " DAILY REPORT").toUpperCase(), 610), 480, 204);
            setFont(850, 24);
            ctx.fillStyle = selectedAnimationHost.accent;
            ctx.fillText("DAY #" + today, 480, 254);
            setFont(700, 11);
            ctx.fillStyle = "#9297af";
            ctx.fillText("TODAY'S UMA HOST", 480, 292);
            setFont(850, 16);
            ctx.fillStyle = "#f8fafc";
            ctx.fillText(fitText(selectedAnimationHost.name.toUpperCase(), 360), 480, 307);

            const litGateCount = Math.min(10, Math.max(0, Math.floor(time / 0.26) + 1));
            for (let gateIndex = 0; gateIndex < 10; gateIndex += 1) {
              const gateX = 242 + (gateIndex * 49);
              const lit = gateIndex < litGateCount;
              fillRounded(gateX, 369, 36, 42, 8, lit ? "#f4c45f" : "#17182a", lit ? "#fff0a3" : "#4c4260");
              setFont(900, 15);
              ctx.fillStyle = lit ? "#17111d" : "#747991";
              ctx.fillText(String(gateIndex + 1), gateX + 18, 381);
            }
            setFont(720, 12);
            ctx.fillStyle = "#aeb3c8";
            ctx.fillText(litGateCount < 10 ? "GATES CHARGING…" : "ALL GATES READY", 480, 430);
            ctx.textAlign = "left";
            ctx.restore();
          }

          if (shine > 0.01) {
            const light = ctx.createRadialGradient(480, 270, 0, 480, 270, 440);
            light.addColorStop(0, alpha("#ffffff", shine * 0.82));
            light.addColorStop(0.22, alpha("#f4c45f", shine * 0.42));
            light.addColorStop(1, "#00000000");
            ctx.fillStyle = light;
            ctx.fillRect(0, 0, width, height);
          }
        };

        const drawFlyingTransition = (fromIndex, toIndex, progress) => {
          const transitionHost = dashHost || animationHost;
          if (!transitionHost) return;
          const arc = Math.sin(progress * Math.PI);
          const flyHeight = 126 + (arc * 22);
          const flyWidth = flyHeight * (transitionHost.width / transitionHost.height);
          const flyX = lerp(width + 36, -flyWidth - 36, progress);
          const flyY = 248 - (arc * 78) + (Math.sin(progress * Math.PI * 4) * 5);
          ctx.save();
          ctx.globalAlpha = Math.min(1, arc * 1.5);
          for (let trail = 4; trail >= 1; trail -= 1) {
            ctx.globalAlpha = arc * (0.045 * trail);
            ctx.drawImage(transitionHost, flyX + (trail * 38), flyY + (trail * 5), flyWidth, flyHeight);
          }
          ctx.globalAlpha = Math.min(1, arc * 1.5);
          ctx.drawImage(transitionHost, flyX, flyY, flyWidth, flyHeight);

          ctx.restore();
        };

        const introFrames = 56;
        const sceneLength = 62;
        const transitionStart = 38;
        const transitionFrames = 24;
        const totalFrames = introFrames + (storyScenes.length * sceneLength);
        const gif = new window.GIF({
          workers: 2,
          quality: 20,
          width,
          height,
          repeat: 0,
          background: "#090a14",
          workerScript: "./assets/vendor/gif.js/gif.worker.js",
        });

        for (let frame = 0; frame < totalFrames; frame += 1) {
          ctx.fillStyle = "#090a14";
          ctx.fillRect(0, 0, width, height);
          ctx.textBaseline = "top";
          ctx.textAlign = "left";

          if (frame < introFrames) {
            drawStoryScene(0, frame, 1);
            const openingProgress = frame < 21 ? 0 : smoothstep(clamp01((frame - 21) / 27));
            const revealProgress = smoothstep(clamp01((frame - 24) / 21));
            const revealVisibility = 1 - smoothstep(clamp01((frame - 51) / 4));
            drawAcquisitionReveal(revealProgress, frame, revealVisibility);
            drawStartingGate(openingProgress, frame);
          } else {
            const storyFrame = frame - introFrames;
            const sceneIndex = Math.min(storyScenes.length - 1, Math.floor(storyFrame / sceneLength));
            const localFrame = storyFrame - (sceneIndex * sceneLength);
            const rawTransition = clamp01((localFrame - transitionStart) / transitionFrames);
            const transition = smoothstep(rawTransition);

            if (sceneIndex < storyScenes.length - 1) {
              drawStoryScene(sceneIndex, frame, 1 - transition);
              drawStoryScene(sceneIndex + 1, frame, transition);
              if (transition > 0.01 && transition < 0.99) drawFlyingTransition(sceneIndex, sceneIndex + 1, transition);
            } else {
              drawStoryScene(sceneIndex, frame, 1);
              if (transition > 0.01) {
                ctx.save();
                ctx.globalAlpha = transition;
                ctx.fillStyle = "#090a14";
                ctx.fillRect(0, 0, width, height);
                ctx.restore();
                drawStartingGate(1 - transition, frame);
              }
            }
          }

          gif.addFrame(canvas, { copy: true, delay: frameDelay });
        }

        return await new Promise((resolve, reject) => {
          gif.on("finished", resolve);
          gif.on("abort", () => reject(new Error("GIF rendering was cancelled.")));
          gif.render();
        });
      }

      function getAnimationAsset() {
        const filename = safeFilename(club.name) + "-daily-highlight.gif";
        const cacheKey = formatLocalDateKey(dataDate) + "-uma-hosts1";
        return {
          filename,
          label: "Animated Insight Story",
          cacheKey: `${club.id || club.name}-${cacheKey}`,
        };
      }

      async function loadAnimationFile(asset = getAnimationAsset()) {
        const cached = animationAssetCacheRef.current;
        if (cached.key === asset.cacheKey && cached.file) return cached.file;
        if (cached.key === asset.cacheKey && cached.promise) return cached.promise;

        const promise = Promise.resolve()
          .then(async () => {
            const gifBlob = await renderAnimatedInsightStory(getDiscordExportData());
            if (!gifBlob) throw new Error("The animated report could not be created.");
            const file = new File([gifBlob], asset.filename, { type: "image/gif" });
            animationAssetCacheRef.current = { key: asset.cacheKey, file, promise: Promise.resolve(file) };
            return file;
          })
          .catch((error) => {
            if (animationAssetCacheRef.current.key === asset.cacheKey) {
              animationAssetCacheRef.current = { key: "", file: null, promise: null };
            }
            throw error;
          });

        animationAssetCacheRef.current = { key: asset.cacheKey, file: null, promise };
        return promise;
      }

      function readAnimationFileAsDataUrl(file) {
        return new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result || ""));
          reader.onerror = () => reject(reader.error || new Error("The animated report could not be prepared for dragging."));
          reader.readAsDataURL(file);
        });
      }

      function handleAnimationDragStart(event) {
        if (!animationDragAsset?.file || !animationDragAsset?.dataUrl) {
          event.preventDefault();
          return;
        }

        event.dataTransfer.effectAllowed = "copy";
        try {
          event.dataTransfer.items.add(animationDragAsset.file);
        } catch (error) {
          console.info("Direct drag file data was unavailable; using the browser DownloadURL handoff.", error);
        }
        try {
          event.dataTransfer.setData(
            "DownloadURL",
            `image/gif:${animationDragAsset.filename}:${animationDragAsset.dataUrl}`
          );
        } catch (error) {
          console.info("The browser DownloadURL drag format was unavailable; using the attached File object.", error);
        }
        setAnimationExportState("dragging-file");
      }

      function handleAnimationDragEnd() {
        setAnimationExportState("ready-drag");
      }

      async function prepareAnimatedGifForDrag() {
        const busyStates = ["rendering", "preparing-file"];
        if (busyStates.includes(animationExportState)) return;

        const asset = getAnimationAsset();
        try {
          setErr("");
          const hasCachedFile = animationAssetCacheRef.current.key === asset.cacheKey && animationAssetCacheRef.current.file;
          setAnimationExportState(hasCachedFile ? "preparing-file" : "rendering");
          const file = await loadAnimationFile(asset);
          const dataUrl = await readAnimationFileAsDataUrl(file);
          setAnimationDragAsset({ file, filename: asset.filename, dataUrl, cacheKey: asset.cacheKey });
          setAnimationExportState("ready-drag");
        } catch (error) {
          console.error("Animated drag file preparation failed", error);
          setErr(error?.message || "Animated report preparation failed. Refresh and try again.");
          setAnimationExportState("error");
          window.setTimeout(() => setAnimationExportState(false), 5200);
        }
      }

      async function exportAnimatedDailyGif() {
        if (!animationBuildMode || animationExportState === "rendering") return;
        try {
          setErr("");
          const asset = getAnimationAsset();
          setAnimationExportState("rendering");
          const exportData = getDiscordExportData();
          const gifBlob = await renderAnimatedInsightStory(exportData);
          if (!gifBlob) throw new Error("The animated report could not be created.");
          downloadBlob(gifBlob, asset.filename);
          setAnimationExportState("downloaded");
        } catch (error) {
          if (error?.name === "AbortError") setAnimationExportState(false);
          else {
            console.error("Animated GIF export failed", error);
            setErr(error?.message || "Animated GIF export failed. Refresh and try again.");
            setAnimationExportState("error");
          }
        } finally {
          setTimeout(() => setAnimationExportState(false), 3200);
        }
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

      async function exportDiscordPayload(exportData, filename = "circle-report.png", pngRenderer = () => renderDiscordTablePng(exportData, 2)) {
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
        const result = await exportDiscordPayload(exportData, "daily-report.png", () => renderDiscordTablePng(exportData, 2));
        if (!result) return;
        setCopied(result);
        setTimeout(() => setCopied(false), 2200);
      }

      function buildReminderExportData() {
        const ds = dataDate.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
        const priorityOrder = { critical: 0, behind: 1, "on-track": 2 };
        const underPlanMembers = [...decoratedMembers]
          .filter((member) => member.plan.statusKey !== "on-track")
          .sort((a, b) => {
            const priorityDifference = (priorityOrder[a.plan.statusKey] ?? 9) - (priorityOrder[b.plan.statusKey] ?? 9);
            return priorityDifference || (a.plan.delta ?? 0) - (b.plan.delta ?? 0);
          });
        const checkpointDay = currentWeek?.endDay ?? today;
        const daysToCheckpoint = Math.max(1, checkpointDay - today);
        const lines = [`🚨 **[${club.tier}] ${club.name} — Officer Action Board** | ${ds}`, `🗂️ Source: ${getSourceLabel()}`, `⏱️ ${daysToCheckpoint} day${daysToCheckpoint === 1 ? "" : "s"} to the Day ${checkpointDay} checkpoint.`, ""];
        if (!underPlanMembers.length) lines.push("✅ Everyone is currently on track.");
        underPlanMembers.forEach((member) => {
          const meta = STATUS_META[member.plan.statusKey] || STATUS_META["behind"];
          const catchUpDaily = Math.abs(Math.min(0, Number(member.plan.delta ?? 0))) / daysToCheckpoint;
          lines.push(`${meta.icon} **${member.name}** — ${deltaText(member.plan.delta)} vs pace · ${fmt(catchUpDaily)}/day catch-up · ${fmt(member.fansNeededForPlan)} still needed`);
        });
        const footer = `\n> 🤖 *Dominator Network Tracker · ${getDiscordPingLabel()}*`; let message = lines.join("\n") + footer;
        if (message.length > 3900) { const trimmed = []; for (const line of lines) { const candidate = [...trimmed, line].join("\n") + footer; if (candidate.length > 3900) break; trimmed.push(line); } const omitted = Math.max(0, underPlanMembers.length - Math.max(0, trimmed.length - 3)); if (omitted > 0) trimmed.push(`… ${omitted} more members omitted to stay under Discord limit`); message = trimmed.join("\n") + footer; }
        const dailyReport = getDiscordExportData().reportMeta || {};
        const behindCount = underPlanMembers.filter((member) => member.plan.statusKey === "behind").length;
        const criticalCount = underPlanMembers.filter((member) => member.plan.statusKey === "critical").length;
        const combinedGap = underPlanMembers.reduce((sum, member) => sum + Number(member.plan.delta ?? 0), 0);
        const totalStillNeeded = underPlanMembers.reduce((sum, member) => sum + Number(member.fansNeededForPlan ?? 0), 0);
        const totalCatchUpDaily = Math.abs(Math.min(0, combinedGap)) / daysToCheckpoint;
        return {
          fullMessage: message,
          textOnlyMessage: message,
          tableRows: underPlanMembers.map((member) => ({
            name: member.name,
            statusKey: member.plan.statusKey,
            dailyGain: member.dailyGain ?? 0,
            monthlyGain: member.monthlyGain ?? 0,
            paceDelta: member.plan.delta ?? 0,
            catchUpDaily: Math.abs(Math.min(0, Number(member.plan.delta ?? 0))) / daysToCheckpoint,
            stillNeeded: member.fansNeededForPlan ?? 0,
          })),
          reportMeta: {
            dateLabel: ds,
            dayLabel: `Day ${today} of ${dim}`,
            sourceLabel: getSourceLabel(),
            pingLabel: getDiscordPingLabel(),
            periodLabel: `Week ${currentWeek?.number || 1} · ${getWeekLabel(currentWeek, year, monthIndex)}`,
            activeLabel: `${decoratedMembers.length}/${viewMaxMembers} active`,
            targetLabel: `${fmt(club.target)} / member`,
            rankValue: dailyReport.rankValue ?? null,
            rankChange: dailyReport.rankChange ?? null,
            underPlan: underPlanMembers.length,
            behind: behindCount,
            critical: criticalCount,
            combinedGap: fmtSigned(combinedGap),
            stillNeeded: fmt(totalStillNeeded),
            daysToCheckpoint,
            checkpointDay,
            totalCatchUpDaily: fmt(totalCatchUpDaily),
          },
        };
      }

      function buildReminderDiscord() {
        return buildReminderExportData().fullMessage;
      }

      function buildWeeklyComparisonExportData() {
        const ds = dataDate.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
        const previousWeek = monthWeeks.find((week) => week.number === (currentWeek?.number || 1) - 1) || null;
        const title = `📊 **[${club.tier}] ${club.name} — Weekly Report** | ${ds}`;
        const sourceLine = `🗂️ Source: ${getSourceLabel()}`;
        const footer = `> 🤖 *Dominator Network Tracker · ${getDiscordPingLabel()}*`;

        if (!currentWeek) {
          const message = [title, sourceLine, "A weekly period is not available for this date.", "", footer].join("\n");
          return { fullMessage: message, textOnlyMessage: message, pngMessage: message, reportMeta: null, tableRows: [] };
        }

        const currentObservedEndDay = Math.min(today, currentWeek.endDay);
        const currentObservedDays = Math.max(0, currentObservedEndDay - currentWeek.startDay + 1);
        const matchedDays = previousWeek ? Math.min(previousWeek.dayCount, currentObservedDays) : currentObservedDays;
        if (matchedDays <= 0) {
          const message = [title, sourceLine, "The current week does not have a recorded day yet.", "", footer].join("\n");
          return { fullMessage: message, textOnlyMessage: message, pngMessage: message, reportMeta: null, tableRows: [] };
        }

        const previousMatchedEndDay = previousWeek ? previousWeek.startDay + matchedDays - 1 : null;
        const currentMatchedEndDay = currentWeek.startDay + matchedDays - 1;
        const getMatchedLabel = (week, endDay) => `${getDateLabel(year, monthIndex, week.startDay)} – ${getDateLabel(year, monthIndex, endDay)}`;
        const getMatchedGain = (member, week) => (member.dailyGainSeries || [])
          .slice(Math.max(0, week.startDay - 1), Math.max(0, week.startDay - 1 + matchedDays))
          .reduce((sum, value) => sum + (Number(value) || 0), 0);
        const perMemberDailyTarget = club.target / Math.max(dim, 1);
        const perMemberMatchedTarget = Math.round(perMemberDailyTarget * matchedDays);
        const stableThreshold = 0.05;

        const comparisons = decoratedMembers.map((member) => {
          const previousGain = previousWeek ? getMatchedGain(member, previousWeek) : null;
          const currentGain = getMatchedGain(member, currentWeek);
          const previousDailyAverage = previousWeek ? previousGain / matchedDays : null;
          const currentDailyAverage = currentGain / matchedDays;
          const dailyAverageDelta = previousWeek ? currentDailyAverage - previousDailyAverage : null;
          const changeRatio = !previousWeek
            ? null
            : previousDailyAverage > 0
            ? dailyAverageDelta / previousDailyAverage
            : currentDailyAverage > 0 ? Infinity : 0;
          const previousUnderPlan = previousWeek ? previousGain < perMemberMatchedTarget : null;
          const currentUnderPlan = currentGain < perMemberMatchedTarget;
          const newlyUnderPlan = previousWeek ? currentUnderPlan && !previousUnderPlan : currentUnderPlan;
          const isStable = previousWeek && Number.isFinite(changeRatio) && Math.abs(changeRatio) < stableThreshold;
          const movement = !previousWeek
            ? (currentUnderPlan ? "newly-under" : "on-track")
            : newlyUnderPlan
            ? "newly-under"
            : isStable ? "stable"
            : dailyAverageDelta > 0 ? "improved"
            : dailyAverageDelta < 0 ? "declined"
            : "stable";
          return {
            name: member.name,
            previousGain,
            currentGain,
            previousDailyAverage,
            currentDailyAverage,
            dailyAverageDelta,
            changeRatio,
            planDelta: currentGain - perMemberMatchedTarget,
            movement,
          };
        });

        const improved = comparisons.filter((entry) => entry.movement === "improved").sort((a, b) => b.dailyAverageDelta - a.dailyAverageDelta);
        const stable = comparisons.filter((entry) => entry.movement === "stable").sort((a, b) => Math.abs(b.dailyAverageDelta) - Math.abs(a.dailyAverageDelta));
        const declined = comparisons.filter((entry) => entry.movement === "declined").sort((a, b) => a.dailyAverageDelta - b.dailyAverageDelta);
        const newlyUnderPlan = comparisons.filter((entry) => entry.movement === "newly-under").sort((a, b) => a.planDelta - b.planDelta);
        const onTrack = comparisons.filter((entry) => entry.movement === "on-track").sort((a, b) => b.planDelta - a.planDelta);
        const needsAttention = [...newlyUnderPlan, ...declined].sort((a, b) => a.dailyAverageDelta - b.dailyAverageDelta);

        const previousClubGain = previousWeek ? comparisons.reduce((sum, entry) => sum + entry.previousGain, 0) : null;
        const currentClubGain = comparisons.reduce((sum, entry) => sum + entry.currentGain, 0);
        const previousClubDailyAverage = previousWeek ? previousClubGain / matchedDays : null;
        const currentClubDailyAverage = currentClubGain / matchedDays;
        const clubDailyAverageDelta = previousWeek ? currentClubDailyAverage - previousClubDailyAverage : null;
        const clubChangeRatio = !previousWeek ? null : previousClubDailyAverage > 0 ? clubDailyAverageDelta / previousClubDailyAverage : currentClubDailyAverage > 0 ? Infinity : 0;
        const clubTargetThroughMatchedDays = Math.round(perMemberMatchedTarget * comparisons.length);
        const clubPlanDelta = currentClubGain - clubTargetThroughMatchedDays;
        const comparisonLine = previousWeek
          ? `W${previousWeek.number} (${getMatchedLabel(previousWeek, previousMatchedEndDay)}) vs W${currentWeek.number} (${getMatchedLabel(currentWeek, currentMatchedEndDay)}) · matched ${matchedDays} day${matchedDays === 1 ? "" : "s"}`
          : `W${currentWeek.number} (${getWeekLabel(currentWeek, year, monthIndex)}) · ${matchedDays}/${currentWeek.dayCount} day${currentWeek.dayCount === 1 ? "" : "s"} recorded`;
        const currentWeekState = currentObservedDays < currentWeek.dayCount
          ? `Current week is partial: ${currentObservedDays}/${currentWeek.dayCount} days recorded.`
          : `Current week is complete: ${currentObservedDays}/${currentWeek.dayCount} days recorded.`;

        const formatChangePercent = (entry) => {
          if (entry.changeRatio == null) return "—";
          if (!Number.isFinite(entry.changeRatio)) return "NEW";
          return `${entry.changeRatio >= 0 ? "+" : ""}${(entry.changeRatio * 100).toFixed(1)}%`;
        };
        const rankMap = rankHistory[cid] || {};
        const previousRank = previousMatchedEndDay == null ? null : (rankMap[formatDateKey(year, monthIndex + 1, previousMatchedEndDay)]?.rank ?? null);
        const currentRank = rankMap[formatDateKey(year, monthIndex + 1, currentMatchedEndDay)]?.rank ?? null;
        const rankDelta = previousRank != null && currentRank != null ? previousRank - currentRank : null;
        const rankLine = currentRank == null
          ? null
          : `🌐 Rank: #${Number(currentRank).toLocaleString()}${rankDelta == null || rankDelta === 0 ? "" : ` ${rankDelta > 0 ? "▲" : "▼"}${Math.abs(rankDelta)}`}`;

        const messageLines = [
          title,
          sourceLine,
          comparisonLine,
          `ℹ️ ${currentWeekState}`,
          "",
          "**CLUB SUMMARY**",
          previousWeek
            ? `Weekly gain: ${fmt(previousClubGain)} → ${fmt(currentClubGain)} (${fmtSigned(currentClubGain - previousClubGain)})`
            : `Weekly gain: ${fmt(currentClubGain)} through ${matchedDays}/${currentWeek.dayCount} days`,
          previousWeek
            ? `Daily average: ${fmt(previousClubDailyAverage)} → ${fmt(currentClubDailyAverage)} (${fmtSigned(clubDailyAverageDelta)} · ${formatChangePercent({ changeRatio: clubChangeRatio })})`
            : `Daily average: ${fmt(currentClubDailyAverage)} across the club`,
          `${clubPlanDelta >= 0 ? "🟢 Ahead of pace" : "🔴 Behind pace"}: ${fmtSigned(clubPlanDelta)} against ${fmt(clubTargetThroughMatchedDays)} target`,
        ];
        if (rankLine) messageLines.push(rankLine);
        messageLines.push(
          "",
          "**MEMBER MOVEMENT**",
          previousWeek
            ? `🟢 Improved: ${improved.length} · ⚪ Stable: ${stable.length} · 🟡 Declined: ${declined.length} · 🔴 Newly under plan: ${newlyUnderPlan.length}`
            : `🟢 On pace: ${onTrack.length} · 🔴 Under plan: ${newlyUnderPlan.length}`,
        );

        if (improved.length) {
          messageLines.push("", "📈 **Top improvements**");
          improved.slice(0, 3).forEach((entry) => messageLines.push(`↑ **${entry.name}** — ${fmt(entry.currentDailyAverage)}/day · ${formatChangePercent(entry)} · ${fmtSigned(entry.planDelta)} vs plan`));
        }
        messageLines.push("", "⚠️ **Needs attention**");
        if (needsAttention.length) {
          needsAttention.slice(0, 3).forEach((entry) => messageLines.push(`${entry.movement === "newly-under" ? "❗" : "↓"} **${entry.name}** — ${fmt(entry.currentDailyAverage)}/day · ${formatChangePercent(entry)} · ${fmtSigned(entry.planDelta)} vs plan`));
        } else {
          messageLines.push("✅ No members declined beyond the 5% stable range.");
        }
        messageLines.push("", "> Full matched-period member comparison is included in the PNG.", footer);

        const charDisplayWidth = (char) => {
          const code = char?.codePointAt(0) ?? 0;
          return (
            (code >= 0x1100 && code <= 0x115F) ||
            (code >= 0x2E80 && code <= 0xA4CF) ||
            (code >= 0xAC00 && code <= 0xD7A3) ||
            (code >= 0xF900 && code <= 0xFAFF) ||
            (code >= 0xFF00 && code <= 0xFF60) ||
            (code >= 0x1F300 && code <= 0x1FAFF)
          ) ? 2 : 1;
        };
        const displayWidth = (value) => Array.from(String(value ?? "")).reduce((sum, char) => sum + charDisplayWidth(char), 0);
        const fitCell = (value, width, alignRight = false) => {
          const chars = Array.from(String(value ?? ""));
          let text = "";
          let used = 0;
          for (const char of chars) {
            const charWidth = charDisplayWidth(char);
            if (used + charWidth > width) break;
            text += char;
            used += charWidth;
          }
          if (used < displayWidth(value) && width > 1) {
            while (displayWidth(text) > width - 1) text = Array.from(text).slice(0, -1).join("");
            text += "…";
          }
          const padding = " ".repeat(Math.max(0, width - displayWidth(text)));
          return alignRight ? `${padding}${text}` : `${text}${padding}`;
        };
        const movementIcon = (entry) => entry.movement === "newly-under" ? "❗" : entry.movement === "improved" || entry.movement === "on-track" ? "✅" : entry.movement === "declined" ? "⚠️" : "•";
        const orderedComparisons = previousWeek
          ? [...newlyUnderPlan, ...declined, ...stable, ...improved]
          : [...newlyUnderPlan, ...onTrack];
        const pngRows = [
          ...orderedComparisons,
        ].map((entry) => `${movementIcon(entry)} ${fitCell(entry.name, 18)} | ${fitCell(fmt(entry.previousDailyAverage), 9, true)} | ${fitCell(fmt(entry.currentDailyAverage), 9, true)} | ${fitCell(fmtSigned(entry.dailyAverageDelta), 9, true)} | ${fitCell(formatChangePercent(entry), 7, true)} | ${fitCell(fmtSigned(entry.planDelta), 9, true)}`);
        const pngMessage = [
          `📊 [${club.tier}] ${club.name} — Weekly Report | ${ds}`,
          `🗂️ Source: ${getSourceLabel()}`,
          comparisonLine,
          currentWeekState,
          "",
          previousWeek
            ? `CLUB GAIN       ${fitCell(fmt(previousClubGain), 10, true)} → ${fitCell(fmt(currentClubGain), 10, true)}  (${fmtSigned(currentClubGain - previousClubGain)})`
            : `CLUB GAIN       ${fitCell(fmt(currentClubGain), 10, true)} through ${matchedDays}/${currentWeek.dayCount} days`,
          previousWeek
            ? `DAILY AVERAGE   ${fitCell(fmt(previousClubDailyAverage), 10, true)} → ${fitCell(fmt(currentClubDailyAverage), 10, true)}  (${fmtSigned(clubDailyAverageDelta)} · ${formatChangePercent({ changeRatio: clubChangeRatio })})`
            : `DAILY AVERAGE   ${fitCell(fmt(currentClubDailyAverage), 10, true)}`,
          `TARGET PACE     ${fitCell(fmt(clubTargetThroughMatchedDays), 10, true)} · ${clubPlanDelta >= 0 ? "ahead" : "behind"} ${fmtSigned(clubPlanDelta)}`,
          rankLine ? rankLine.replace(/\*\*/g, "") : "",
          "",
          `MOVEMENT        Improved ${improved.length} · Stable ${stable.length} · Declined ${declined.length} · Newly under ${newlyUnderPlan.length}`,
          "",
          `${fitCell("MEMBER", 21)} | ${fitCell("PREV/DAY", 9, true)} | ${fitCell("CURR/DAY", 9, true)} | ${fitCell("Δ/DAY", 9, true)} | ${fitCell("Δ%", 7, true)} | ${fitCell("VS PLAN", 9, true)}`,
          `${"─".repeat(21)}-+-${"─".repeat(9)}-+-${"─".repeat(9)}-+-${"─".repeat(9)}-+-${"─".repeat(7)}-+-${"─".repeat(9)}`,
          ...pngRows,
          "",
          `> Dominator Network Tracker · ${getDiscordPingLabel()}`,
        ].filter((line, index, lines) => line || (index > 0 && lines[index - 1] !== "")).join("\n");

        let fullMessage = messageLines.join("\n");
        if (fullMessage.length > 3900) fullMessage = fullMessage.slice(0, 3897) + "…";
        return {
          fullMessage,
          textOnlyMessage: fullMessage,
          pngMessage,
          tableRows: orderedComparisons,
          reportMeta: {
            dateLabel: ds,
            sourceLabel: getSourceLabel(),
            pingLabel: getDiscordPingLabel(),
            periodLabel: `Week ${currentWeek.number} · ${getWeekLabel(currentWeek, year, monthIndex)}`,
            observedLabel: `${matchedDays}/${currentWeek.dayCount} days recorded`,
            activeLabel: `${comparisons.length}/${viewMaxMembers} active`,
            targetLabel: `${fmt(perMemberMatchedTarget)} / member`,
            previousAvailable: Boolean(previousWeek),
            previousWeekLabel: previousWeek ? `W${previousWeek.number} gain` : "Pace target",
            previousGain: previousWeek ? fmtSigned(previousClubGain) : fmt(clubTargetThroughMatchedDays),
            currentWeekLabel: `W${currentWeek.number} gain`,
            currentGain: fmtSigned(currentClubGain),
            planDelta: fmtSigned(clubPlanDelta),
            planPositive: clubPlanDelta >= 0,
            rankValue: currentRank == null ? null : Number(currentRank),
            rankDelta,
            improved: improved.length,
            stable: stable.length,
            declined: declined.length,
            newlyUnder: newlyUnderPlan.length,
            onTrack: onTrack.length,
            matchedDays,
            memberCount: comparisons.length,
          },
        };
      }

      async function renderWeeklyComparisonPng(exportData, scale = 2) {
        const report = exportData?.reportMeta;
        const rows = Array.isArray(exportData?.tableRows) ? exportData.tableRows : [];
        if (!report || !rows.length) return null;

        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d");
        if (!ctx) return null;

        const loadCanvasImage = (url) => new Promise((resolve) => {
          if (!url) return resolve(null);
          const image = new Image();
          image.onload = () => resolve(image);
          image.onerror = () => resolve(null);
          image.src = url;
        });
        const tierIconUrl = getRankIconUrl(club.tier, viewRankingConfig, viewRankIconPath);
        const currentRankTier = getTierForRank(report.rankValue, viewRankingConfig);
        const currentRankIconUrl = getRankIconUrl(currentRankTier, viewRankingConfig, viewRankIconPath);
        const tierIconImage = await loadCanvasImage(tierIconUrl);
        const currentRankIconImage = currentRankIconUrl === tierIconUrl
          ? tierIconImage
          : await loadCanvasImage(currentRankIconUrl);

        const width = 1160;
        const outerPadding = 44;
        const headerHeight = 162;
        const metricHeight = 152;
        const metricGap = 14;
        const summaryHeight = 82;
        const tableHeaderHeight = 66;
        const rowHeight = 76;
        const footerHeight = 78;
        const sectionGap = 22;
        const height = outerPadding + headerHeight + sectionGap + metricHeight + sectionGap + summaryHeight + sectionGap + tableHeaderHeight + (rows.length * rowHeight) + footerHeight + outerPadding;

        canvas.width = Math.ceil(width * scale);
        canvas.height = Math.ceil(height * scale);
        ctx.scale(scale, scale);
        ctx.textBaseline = "top";
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";

        const roundedRect = (x, y, w, h, r) => {
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
        const fillRounded = (x, y, w, h, r, fill, stroke = null) => {
          roundedRect(x, y, w, h, r);
          ctx.fillStyle = fill;
          ctx.fill();
          if (stroke) {
            ctx.strokeStyle = stroke;
            ctx.lineWidth = 1;
            ctx.stroke();
          }
        };
        const setFont = (weight, size, family = "Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif") => {
          ctx.font = `${weight} ${size}px ${family}`;
        };
        const fitText = (value, maxWidth) => {
          const text = String(value ?? "");
          if (ctx.measureText(text).width <= maxWidth) return text;
          let output = text;
          while (output.length > 1 && ctx.measureText(`${output}…`).width > maxWidth) output = output.slice(0, -1);
          return `${output}…`;
        };
        const drawLabel = (label, x, y, color = "#8f93ad") => {
          setFont(700, 16);
          ctx.fillStyle = color;
          ctx.fillText(String(label).toUpperCase(), x, y);
        };
        const drawMetricCard = ({ x, y, w, label, value, detail, accent, detailColor = "#9ca3af" }) => {
          fillRounded(x, y, w, metricHeight, 18, "#17182a", "#2a2c45");
          fillRounded(x, y, 5, metricHeight, 3, accent);
          drawLabel(label, x + 22, y + 20);
          setFont(800, 38);
          ctx.fillStyle = "#f8fafc";
          ctx.fillText(value, x + 22, y + 49);
          setFont(650, 18);
          ctx.fillStyle = detailColor;
          ctx.fillText(fitText(detail, w - 44), x + 22, y + 106);
        };
        const movementMeta = (movement) => ({
          "on-track": { label: "On pace", color: "#34d399", bg: "#10332d", border: "#1e6758" },
          improved: { label: "Improved", color: "#34d399", bg: "#10332d", border: "#1e6758" },
          stable: { label: "Stable", color: "#c4c7d7", bg: "#252637", border: "#45475e" },
          declined: { label: "Declined", color: "#fbbf24", bg: "#3a2d13", border: "#765718" },
          "newly-under": { label: "Under plan", color: "#f87171", bg: "#3b1c24", border: "#7d2e3d" },
        }[movement] || { label: "Stable", color: "#c4c7d7", bg: "#252637", border: "#45475e" });

        const background = ctx.createLinearGradient(0, 0, width, height);
        background.addColorStop(0, "#090a14");
        background.addColorStop(0.55, "#0d0d1b");
        background.addColorStop(1, "#111225");
        ctx.fillStyle = background;
        ctx.fillRect(0, 0, width, height);
        const glow = ctx.createRadialGradient(width - 140, 80, 0, width - 140, 80, 380);
        glow.addColorStop(0, `${tc.bar}42`);
        glow.addColorStop(1, "#00000000");
        ctx.fillStyle = glow;
        ctx.fillRect(0, 0, width, 520);

        let y = outerPadding;
        const headerIconSize = 84;
        const headerTextX = outerPadding + 108;
        if (tierIconImage) {
          ctx.drawImage(tierIconImage, outerPadding, y + 5, headerIconSize, headerIconSize);
        } else {
          fillRounded(outerPadding, y + 5, headerIconSize, headerIconSize, 22, tc.bar, tc.border);
          setFont(900, 26);
          ctx.fillStyle = "#ffffff";
          ctx.textAlign = "center";
          ctx.fillText(club.tier, outerPadding + (headerIconSize / 2), y + 32);
          ctx.textAlign = "left";
        }
        drawLabel("Dominator Network · Weekly Report", headerTextX, y + 4, tc.text);
        setFont(850, 42);
        ctx.fillStyle = "#f8fafc";
        ctx.textAlign = "center";
        ctx.fillText(fitText(club.name, width - 360), width / 2, y + 31);
        ctx.textAlign = "left";
        setFont(550, 20);
        ctx.fillStyle = "#a9adc2";
        ctx.fillText(`${report.periodLabel}  ·  ${report.observedLabel}  ·  ${report.sourceLabel}`, headerTextX, y + 88);
        ctx.fillText(`${report.pingLabel}  ·  ${report.activeLabel}  ·  Target ${report.targetLabel}`, headerTextX, y + 119);

        y += headerHeight + sectionGap;
        const metricsWidth = width - (outerPadding * 2);
        const cardWidth = (metricsWidth - (metricGap * 3)) / 4;
        const rankAccent = report.rankDelta > 0 ? "#34d399" : report.rankDelta < 0 ? "#f87171" : "#8187a5";
        const rankDetailColor = report.rankDelta > 0 ? "#65e5ad" : report.rankDelta < 0 ? "#ff9292" : "#a9adc2";
        fillRounded(outerPadding, y, cardWidth, metricHeight, 18, "#17182a", "#2a2c45");
        fillRounded(outerPadding, y, 5, metricHeight, 3, rankAccent);
        drawLabel("Club rank", outerPadding + 22, y + 20);
        const rankText = report.rankValue == null ? "—" : Number(report.rankValue).toLocaleString();
        const rankIconSize = 64;
        if (currentRankIconImage) ctx.drawImage(currentRankIconImage, outerPadding + 22, y + 35, rankIconSize, rankIconSize);
        setFont(800, 44);
        ctx.fillStyle = "#f8fafc";
        ctx.fillText(rankText, outerPadding + 22 + (currentRankIconImage ? rankIconSize + 10 : 0), y + 45);
        setFont(650, 18);
        ctx.fillStyle = rankDetailColor;
        const rankDetail = report.rankDelta == null ? "Unavailable" : report.rankDelta > 0 ? `▲${Math.abs(report.rankDelta)} this week` : report.rankDelta < 0 ? `▼${Math.abs(report.rankDelta)} this week` : "No change";
        ctx.fillText(rankDetail, outerPadding + 22, y + 106);
        drawMetricCard({ x: outerPadding + cardWidth + metricGap, y, w: cardWidth, label: report.currentWeekLabel, value: report.currentGain, detail: "Current period", accent: "#60a5fa" });
        drawMetricCard({ x: outerPadding + (cardWidth + metricGap) * 2, y, w: cardWidth, label: report.previousWeekLabel, value: report.previousGain, detail: report.previousAvailable ? "Matched prior period" : "Elapsed target", accent: tc.text });
        drawMetricCard({ x: outerPadding + (cardWidth + metricGap) * 3, y, w: cardWidth, label: "Vs pace", value: report.planDelta, detail: report.planPositive ? "Ahead of pace" : "Behind pace", accent: report.planPositive ? "#34d399" : "#f87171", detailColor: report.planPositive ? "#65e5ad" : "#ff9292" });

        y += metricHeight + sectionGap;
        fillRounded(outerPadding, y, metricsWidth, summaryHeight, 16, "#141526", "#282a42");
        const summaryCenterY = y + (summaryHeight / 2);
        ctx.textBaseline = "middle";
        drawLabel(report.previousAvailable ? "Member movement" : "Member pace", outerPadding + 22, summaryCenterY);
        const summaryItems = report.previousAvailable
          ? [
              { label: "IMPROVED", value: report.improved, color: "#34d399" },
              { label: "STABLE", value: report.stable, color: "#c4c7d7" },
              { label: "DECLINED", value: report.declined, color: "#fbbf24" },
              { label: "UNDER PLAN", value: report.newlyUnder, color: "#f87171" },
            ]
          : [
              { label: "ON PACE", value: report.onTrack, color: "#34d399" },
              { label: "UNDER PLAN", value: report.newlyUnder, color: "#f87171" },
              { label: "DAYS", value: report.matchedDays, color: "#60a5fa" },
              { label: "ACTIVE", value: report.memberCount, color: "#c4c7d7" },
            ];
        const summaryLabelWidth = 220;
        const summaryGroupWidth = (metricsWidth - summaryLabelWidth) / summaryItems.length;
        summaryItems.forEach((item, index) => {
          const centerX = outerPadding + summaryLabelWidth + (summaryGroupWidth * (index + 0.5));
          const dotX = centerX - 48;
          ctx.fillStyle = item.color;
          ctx.beginPath();
          ctx.arc(dotX, summaryCenterY, 7, 0, Math.PI * 2);
          ctx.fill();
          setFont(800, 30);
          ctx.textAlign = "right";
          ctx.fillText(String(item.value), dotX + 55, summaryCenterY);
          setFont(700, 14);
          ctx.fillStyle = "#9297af";
          ctx.textAlign = "left";
          ctx.fillText(item.label, dotX + 67, summaryCenterY);
        });
        ctx.textAlign = "left";
        ctx.textBaseline = "top";

        y += summaryHeight + sectionGap;
        const movementX = outerPadding + 330;
        const movementWidth = 150;
        const column = {
          member: outerPadding + 22,
          movement: movementX,
          movementCenter: movementX + (movementWidth / 2),
          previousRight: outerPadding + 606,
          currentRight: outerPadding + 756,
          changeRight: outerPadding + 901,
          planRight: width - outerPadding - 22,
        };
        fillRounded(outerPadding, y, metricsWidth, tableHeaderHeight, 15, "#1a1b2e", "#2c2e48");
        ctx.textBaseline = "middle";
        const tableHeaderCenterY = y + (tableHeaderHeight / 2);
        drawLabel("Member", column.member, tableHeaderCenterY);
        ctx.textAlign = "center";
        drawLabel("Movement", column.movementCenter, tableHeaderCenterY);
        ctx.textAlign = "right";
        drawLabel("Prev / day", column.previousRight, tableHeaderCenterY);
        drawLabel("Current / day", column.currentRight, tableHeaderCenterY);
        drawLabel("Change", column.changeRight, tableHeaderCenterY);
        drawLabel("Vs plan", column.planRight, tableHeaderCenterY);
        ctx.textAlign = "left";
        y += tableHeaderHeight;

        rows.forEach((row, index) => {
          const movement = movementMeta(row.movement);
          const rowFill = index % 2 === 0 ? "#111221" : "#0d0e1a";
          const rowCenterY = y + (rowHeight / 2);
          ctx.fillStyle = rowFill;
          ctx.fillRect(outerPadding, y, metricsWidth, rowHeight);
          ctx.fillStyle = movement.color;
          ctx.fillRect(outerPadding, y, 4, rowHeight);
          setFont(700, 27);
          ctx.fillStyle = "#eef0f8";
          ctx.fillText(fitText(row.name, 250), column.member, rowCenterY);
          fillRounded(column.movement, y + ((rowHeight - 38) / 2), movementWidth, 38, 19, movement.bg, movement.border);
          setFont(750, 15);
          ctx.fillStyle = movement.color;
          ctx.textAlign = "center";
          ctx.fillText(movement.label.toUpperCase(), column.movementCenter, rowCenterY);
          const mono = "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";
          setFont(700, 23, mono);
          ctx.fillStyle = "#d8dbea";
          ctx.textAlign = "right";
          ctx.fillText(report.previousAvailable ? fmt(row.previousDailyAverage) : "—", column.previousRight, rowCenterY);
          ctx.fillText(fmt(row.currentDailyAverage), column.currentRight, rowCenterY);
          ctx.fillStyle = row.dailyAverageDelta == null ? "#9ca3af" : row.dailyAverageDelta >= 0 ? "#65e5ad" : "#ff9292";
          ctx.fillText(row.dailyAverageDelta == null ? "—" : fmtSigned(row.dailyAverageDelta), column.changeRight, rowCenterY);
          ctx.fillStyle = row.planDelta >= 0 ? "#65e5ad" : "#ff9292";
          ctx.fillText(fmtSigned(row.planDelta), column.planRight, rowCenterY);
          ctx.textAlign = "left";
          y += rowHeight;
        });

        ctx.textBaseline = "top";
        ctx.strokeStyle = "#292b43";
        ctx.beginPath();
        ctx.moveTo(outerPadding, y);
        ctx.lineTo(width - outerPadding, y);
        ctx.stroke();
        setFont(700, 17);
        ctx.fillStyle = "#858aa3";
        ctx.fillText("Dominator Network Tracker", outerPadding, y + 28);
        ctx.textAlign = "right";
        ctx.fillText(`${report.sourceLabel} · ${report.dateLabel}`, width - outerPadding, y + 28);
        ctx.textAlign = "left";
        return await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
      }

      async function copyWeeklyDiscord() {
        const exportData = buildWeeklyComparisonExportData();
        const result = await exportDiscordPayload(
          exportData,
          "weekly-comparison.png",
          () => renderWeeklyComparisonPng(exportData, 2)
        );
        if (!result) return;
        setWeeklyCopied(result);
        setTimeout(() => setWeeklyCopied(false), 2200);
      }

      async function renderReminderPng(exportData, scale = 2) {
        const report = exportData?.reportMeta;
        const rows = Array.isArray(exportData?.tableRows) ? exportData.tableRows : [];
        if (!report) return null;

        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d");
        if (!ctx) return null;
        const loadCanvasImage = (url) => new Promise((resolve) => {
          if (!url) return resolve(null);
          const image = new Image();
          image.onload = () => resolve(image);
          image.onerror = () => resolve(null);
          image.src = url;
        });
        const tierIconUrl = getRankIconUrl(club.tier, viewRankingConfig, viewRankIconPath);
        const currentRankTier = getTierForRank(report.rankValue, viewRankingConfig);
        const currentRankIconUrl = getRankIconUrl(currentRankTier, viewRankingConfig, viewRankIconPath);
        const tierIconImage = await loadCanvasImage(tierIconUrl);
        const currentRankIconImage = currentRankIconUrl === tierIconUrl
          ? tierIconImage
          : await loadCanvasImage(currentRankIconUrl);

        const width = 1160;
        const outerPadding = 44;
        const headerHeight = 148;
        const alertHeight = 224;
        const sectionHeaderHeight = 58;
        const cardHeight = 148;
        const cardGap = 14;
        const sectionGap = 24;
        const footerHeight = 76;
        const gridRows = Math.max(1, Math.ceil(rows.length / 2));
        const cardsHeight = (gridRows * cardHeight) + (Math.max(0, gridRows - 1) * cardGap);
        const height = outerPadding + headerHeight + sectionGap + alertHeight + sectionGap + sectionHeaderHeight + cardsHeight + footerHeight + outerPadding;
        canvas.width = Math.ceil(width * scale);
        canvas.height = Math.ceil(height * scale);
        ctx.scale(scale, scale);
        ctx.textBaseline = "top";
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";

        const roundedRect = (x, y, w, h, r) => {
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
        const fillRounded = (x, y, w, h, r, fill, stroke = null) => {
          roundedRect(x, y, w, h, r);
          ctx.fillStyle = fill;
          ctx.fill();
          if (stroke) {
            ctx.strokeStyle = stroke;
            ctx.lineWidth = 1;
            ctx.stroke();
          }
        };
        const setFont = (weight, size, family = "Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif") => {
          ctx.font = `${weight} ${size}px ${family}`;
        };
        const fitText = (value, maxWidth) => {
          const text = String(value ?? "");
          if (ctx.measureText(text).width <= maxWidth) return text;
          let output = text;
          while (output.length > 1 && ctx.measureText(`${output}…`).width > maxWidth) output = output.slice(0, -1);
          return `${output}…`;
        };
        const drawLabel = (label, x, y, color = "#8f93ad", align = "left") => {
          setFont(750, 14);
          ctx.fillStyle = color;
          ctx.textAlign = align;
          ctx.fillText(String(label).toUpperCase(), x, y);
        };
        const mono = "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";

        const background = ctx.createLinearGradient(0, 0, width, height);
        background.addColorStop(0, "#080912");
        background.addColorStop(0.5, "#0d0e1b");
        background.addColorStop(1, "#111225");
        ctx.fillStyle = background;
        ctx.fillRect(0, 0, width, height);
        const glow = ctx.createRadialGradient(width - 120, 120, 0, width - 120, 120, 430);
        glow.addColorStop(0, "#f59e0b38");
        glow.addColorStop(1, "#00000000");
        ctx.fillStyle = glow;
        ctx.fillRect(0, 0, width, 520);

        let y = outerPadding;
        const headerIconSize = 86;
        if (tierIconImage) ctx.drawImage(tierIconImage, outerPadding, y + 8, headerIconSize, headerIconSize);
        else {
          fillRounded(outerPadding, y + 8, headerIconSize, headerIconSize, 22, "#39270f", "#8a5d15");
          setFont(900, 28);
          ctx.fillStyle = "#fbbf24";
          ctx.textAlign = "center";
          ctx.fillText(club.tier, outerPadding + (headerIconSize / 2), y + 35);
        }
        drawLabel("Dominator Network · Officer Action Board", outerPadding + 112, y + 5, "#fbbf24");
        setFont(850, 44);
        ctx.fillStyle = "#f8fafc";
        ctx.textAlign = "center";
        ctx.fillText(fitText(club.name, 560), width / 2, y + 32);
        setFont(600, 19);
        ctx.fillStyle = "#a9adc2";
        ctx.fillText(`${report.dateLabel}  ·  ${report.dayLabel}  ·  ${report.sourceLabel}`, width / 2, y + 91);
        ctx.fillText(`${report.pingLabel}  ·  ${report.activeLabel}  ·  Target ${report.targetLabel}`, width / 2, y + 119);

        const rankPanelX = width - outerPadding - 154;
        fillRounded(rankPanelX, y + 2, 154, 112, 18, "#141526", "#2b2d47");
        drawLabel("Club rank", rankPanelX + 77, y + 16, "#8f93ad", "center");
        const rankText = report.rankValue == null ? "—" : Number(report.rankValue).toLocaleString();
        const rankIconSize = 48;
        if (currentRankIconImage) ctx.drawImage(currentRankIconImage, rankPanelX + 20, y + 39, rankIconSize, rankIconSize);
        setFont(850, 36);
        ctx.fillStyle = "#f8fafc";
        ctx.textAlign = "left";
        ctx.fillText(rankText, rankPanelX + (currentRankIconImage ? 76 : 28), y + 45);
        setFont(700, 13);
        ctx.fillStyle = report.rankChange > 0 ? "#65e5ad" : report.rankChange < 0 ? "#ff9292" : "#9ca3af";
        ctx.textAlign = "center";
        const rankDetail = report.rankChange == null ? "Unavailable" : report.rankChange > 0 ? `▲${Math.abs(report.rankChange)} today` : report.rankChange < 0 ? `▼${Math.abs(report.rankChange)} today` : "No change";
        ctx.fillText(rankDetail, rankPanelX + 77, y + 91);

        y += headerHeight + sectionGap;
        const contentWidth = width - (outerPadding * 2);
        roundedRect(outerPadding, y, contentWidth, alertHeight, 24);
        const alertGradient = ctx.createLinearGradient(outerPadding, y, width - outerPadding, y + alertHeight);
        alertGradient.addColorStop(0, report.underPlan ? "#34170f" : "#0d2b25");
        alertGradient.addColorStop(0.58, "#1c1620");
        alertGradient.addColorStop(1, "#111a2d");
        ctx.fillStyle = alertGradient;
        ctx.fill();
        ctx.strokeStyle = report.underPlan ? "#7c3320" : "#23634f";
        ctx.lineWidth = 1;
        ctx.stroke();
        fillRounded(outerPadding, y, 7, alertHeight, 4, report.critical ? "#f87171" : report.underPlan ? "#fbbf24" : "#34d399");

        drawLabel(report.underPlan ? "Immediate follow-up required" : "No action required", outerPadding + 30, y + 25, report.underPlan ? "#fbbf24" : "#65e5ad");
        setFont(900, 50);
        ctx.fillStyle = "#fff7ed";
        ctx.textAlign = "left";
        ctx.fillText(`${report.underPlan} MEMBER${report.underPlan === 1 ? "" : "S"}`, outerPadding + 30, y + 50);
        setFont(750, 22);
        ctx.fillStyle = "#d8dbea";
        ctx.fillText(`${report.critical} critical  ·  ${report.behind} behind`, outerPadding + 32, y + 111);

        const countdownX = width - outerPadding - 300;
        fillRounded(countdownX, y + 22, 272, 112, 20, "#111827cc", "#34537c");
        drawLabel("Time to checkpoint", countdownX + 136, y + 39, "#93c5fd", "center");
        setFont(900, 46);
        ctx.fillStyle = "#dbeafe";
        ctx.textAlign = "center";
        ctx.fillText(`${report.daysToCheckpoint} DAY${report.daysToCheckpoint === 1 ? "" : "S"}`, countdownX + 136, y + 57);
        setFont(700, 15);
        ctx.fillStyle = "#8fadd2";
        ctx.fillText(`DAY ${report.checkpointDay} WEEKLY CHECKPOINT`, countdownX + 136, y + 107);

        const statY = y + 158;
        const statWidth = contentWidth / 3;
        const stats = [
          { label: "Combined pace gap", value: report.combinedGap, color: "#ff9292" },
          { label: "Required catch-up / day", value: report.totalCatchUpDaily, color: "#93c5fd" },
          { label: "Remaining monthly quota", value: report.stillNeeded, color: "#fbbf24" },
        ];
        stats.forEach((stat, index) => {
          const centerX = outerPadding + (statWidth * (index + 0.5));
          if (index > 0) {
            ctx.strokeStyle = "#3a3040";
            ctx.beginPath();
            ctx.moveTo(outerPadding + (statWidth * index), statY + 2);
            ctx.lineTo(outerPadding + (statWidth * index), statY + 49);
            ctx.stroke();
          }
          drawLabel(stat.label, centerX, statY, "#9fa3b8", "center");
          setFont(850, 29, mono);
          ctx.fillStyle = stat.color;
          ctx.textAlign = "center";
          ctx.fillText(stat.value, centerX, statY + 24);
        });

        y += alertHeight + sectionGap;
        drawLabel("Priority queue", outerPadding, y + 4, "#fbbf24");
        setFont(650, 16);
        ctx.fillStyle = "#858aa3";
        ctx.textAlign = "right";
        ctx.fillText("MOST URGENT FIRST · DAILY CATCH-UP TARGETS", width - outerPadding, y + 4);
        ctx.textAlign = "left";
        y += sectionHeaderHeight;

        if (!rows.length) {
          fillRounded(outerPadding, y, contentWidth, cardHeight, 20, "#10251f", "#26604e");
          setFont(850, 30);
          ctx.fillStyle = "#65e5ad";
          ctx.textAlign = "center";
          ctx.fillText("Everyone is currently on track.", width / 2, y + 44);
          setFont(600, 19);
          ctx.fillStyle = "#a7d7c5";
          ctx.fillText("No member follow-up is needed for this checkpoint.", width / 2, y + 87);
          ctx.textAlign = "left";
          y += cardHeight;
        } else {
          const cardWidth = (contentWidth - cardGap) / 2;
          rows.forEach((row, index) => {
            const status = getDisplayStatusMeta(row.statusKey);
            const columnIndex = index % 2;
            const rowIndex = Math.floor(index / 2);
            const cardX = outerPadding + (columnIndex * (cardWidth + cardGap));
            const cardY = y + (rowIndex * (cardHeight + cardGap));
            const progress = Math.max(0, Math.min(1, Number(row.monthlyGain || 0) / Math.max(1, Number(club.target || 1))));
            fillRounded(cardX, cardY, cardWidth, cardHeight, 18, "#151626", status.border || "#30324b");
            fillRounded(cardX, cardY, 6, cardHeight, 3, status.color);

            setFont(900, 32, mono);
            ctx.fillStyle = "#4c5068";
            ctx.textAlign = "left";
            ctx.fillText(String(index + 1).padStart(2, "0"), cardX + 22, cardY + 18);
            setFont(800, 25);
            ctx.fillStyle = "#f1f3fa";
            ctx.fillText(fitText(row.name, cardWidth - 225), cardX + 78, cardY + 21);

            const pillWidth = 112;
            fillRounded(cardX + cardWidth - pillWidth - 18, cardY + 18, pillWidth, 34, 17, status.bg, status.border);
            setFont(800, 13);
            ctx.fillStyle = status.color;
            ctx.textAlign = "center";
            ctx.fillText(status.label.toUpperCase(), cardX + cardWidth - (pillWidth / 2) - 18, cardY + 27);

            const progressX = cardX + 22;
            const progressY = cardY + 65;
            const progressWidth = cardWidth - 44;
            fillRounded(progressX, progressY, progressWidth, 8, 4, "#292b40");
            fillRounded(progressX, progressY, Math.max(8, progressWidth * progress), 8, 4, status.color);
            setFont(650, 13);
            ctx.fillStyle = "#858aa3";
            ctx.textAlign = "left";
            ctx.fillText(`MONTH ${Math.round(progress * 100)}%`, progressX, cardY + 78);
            ctx.textAlign = "right";
            ctx.fillText(fmtSigned(row.monthlyGain), cardX + cardWidth - 22, cardY + 78);

            const metricTop = cardY + 104;
            const metricWidth = (cardWidth - 44) / 3;
            const cardStats = [
              { label: "PACE GAP", value: fmtSigned(row.paceDelta), color: "#ff9292" },
              { label: "CATCH-UP / DAY", value: fmt(row.catchUpDaily), color: "#93c5fd" },
              { label: "STILL NEEDED", value: fmt(row.stillNeeded), color: "#fbbf24" },
            ];
            cardStats.forEach((stat, statIndex) => {
              const statCenterX = cardX + 22 + (metricWidth * (statIndex + 0.5));
              drawLabel(stat.label, statCenterX, metricTop, "#7f849c", "center");
              setFont(800, 18, mono);
              ctx.fillStyle = stat.color;
              ctx.textAlign = "center";
              ctx.fillText(stat.value, statCenterX, metricTop + 20);
            });
          });
          y += cardsHeight;
        }

        ctx.strokeStyle = "#292b43";
        ctx.beginPath();
        ctx.moveTo(outerPadding, y + 1);
        ctx.lineTo(width - outerPadding, y + 1);
        ctx.stroke();
        setFont(700, 17);
        ctx.fillStyle = "#858aa3";
        ctx.textAlign = "left";
        ctx.fillText("Dominator Network Tracker", outerPadding, y + 29);
        ctx.textAlign = "right";
        ctx.fillText(`${report.periodLabel} · ${report.dateLabel}`, width - outerPadding, y + 29);
        ctx.textAlign = "left";
        return await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
      }

      async function copyReminderDiscord() {
        const exportData = buildReminderExportData();
        const result = await exportDiscordPayload(
          exportData,
          "officer-action-board.png",
          () => renderReminderPng(exportData, 2)
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
        root: { background: "transparent", minHeight: "100vh", color: "#f3e9ee", fontFamily: "'Inter',system-ui,sans-serif", padding: "16px", maxWidth: 1480, margin: "0 auto" },
        card: {
          background: "linear-gradient(168deg, rgba(47,29,39,0.66) 0%, rgba(30,22,28,0.86) 52%, rgba(23,18,22,0.92) 100%)",
          border: "1px solid rgba(244,164,177,0.16)",
          borderRadius: 16,
          padding: "16px 18px",
          marginBottom: 14,
          boxShadow: "0 1px 0 rgba(243,233,238,0.05) inset, 0 14px 36px rgba(3,2,10,0.55), 0 0 0 0.5px rgba(169,63,86,0.06)",
        },
        h2: { fontSize: 11, fontWeight: 800, color: "#c3a7b2", textTransform: "uppercase", letterSpacing: "0.16em", margin: "0 0 14px", paddingLeft: 10, borderLeft: "3px solid #a93f56", lineHeight: 1.2 },
        btn: (active, col = "#a93f56") => ({
          background: active ? `linear-gradient(150deg, ${col}, ${col}cc)` : "rgba(34,24,31,0.85)",
          color: active ? "#fff" : "#c3a7b2",
          border: `1px solid ${active ? col : "rgba(244,164,177,0.18)"}`,
          borderRadius: 999,
          padding: "7px 15px",
          cursor: "pointer",
          fontSize: 12,
          fontWeight: 700,
          letterSpacing: "0.01em",
          boxShadow: active ? `0 4px 16px ${col}55, 0 0 0 1px ${col}33 inset` : "none",
          transition: "all 0.15s",
        }),
        input: { width: "100%", background: "rgba(21,16,21,0.85)", border: "1px solid rgba(244,164,177,0.22)", color: "#f3e9ee", borderRadius: 9, padding: "7px 9px", fontSize: 11 },
        th: { padding: "10px 8px", borderBottom: "1px solid rgba(244,164,177,0.18)", color: "#c3a7b2", fontSize: 10.5, fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.06em", whiteSpace: "nowrap" },
        td: { padding: "10px 8px", borderBottom: "1px solid rgba(59,41,50,0.85)", fontSize: 12, verticalAlign: "middle" },
      };

      const accent = view === "home" ? "#ffd0d8" : tc.text;
      const discordActionsBlocked = false;
      const actionButtonDisabledStyle = (resetWindowBlocksExports || discordActionsBlocked) ? { opacity: 0.45, cursor: "not-allowed", filter: "saturate(0.5)" } : null;
      const actionButtonTitle = resetWindowBlocksExports ? "Available after the current Chronogenesis day is confirmed." : "";
      const clubDetailParams = new URLSearchParams();
      if (cid) clubDetailParams.set("id", String(cid));
      if (archiveMonth) clubDetailParams.set("month", archiveMonth);
      const clubDetailHref = `./club.html${clubDetailParams.toString() ? `?${clubDetailParams.toString()}` : ""}`;
      const insightsHref = "./archives.html";
      const navLinkStyle = (active, color) => ({ ...S.btn(active, active ? "#a93f56" : color), display: "flex", alignItems: "center", gap: 8, width: "100%", textDecoration: "none", fontSize: 14 });

      return (
        <div style={S.root}>
          {/* ── Mobile top bar ── */}
          <div className="mobile-topbar">
            <div style={{ display: "flex", alignItems: "center", gap: 9, minWidth: 0 }}>
              <a href="./index.html" aria-label="Go to Home" title="Go to Home" style={{ display: "inline-flex", textDecoration: "none", borderRadius: 9 }}><span className="gate-badge" style={{ width: 30, height: 30, borderRadius: 9, fontSize: 16 }}>⬡</span></a>
              <div style={{ minWidth: 0 }}>
                <div className="wordmark" style={{ fontSize: 15 }}>Dominator Network</div>
                <div style={{ color: "#c3a7b2", fontSize: 9, fontWeight: 700 }}>Day {today}/{dim} · {daysLeft} left{isArchiveView ? ` · 📦 ${archiveMonth}` : ""}</div>
              </div>
            </div>
            <div className="telemetry" style={{ flex: "0 0 auto", textAlign: "right" }}>
              <div style={{ color: loading ? "#34d399" : "#c3a7b2", fontSize: 8, fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.12em" }}>{loading ? "Refreshing…" : "Next refresh"}</div>
              <RefreshCountdown style={{ color: "#f3e9ee", fontSize: 14, fontWeight: 700 }} />
            </div>
          </div>

          <div className="app-shell">
            {/* ── Paddock rail (desktop) ── */}
            <aside className="rail">
              <div>
                <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
                  <a href="./index.html" aria-label="Go to Home" title="Go to Home" style={{ display: "inline-flex", textDecoration: "none", borderRadius: 11 }}><span className="gate-badge">⬡</span></a>
                  <div>
                    <div className="wordmark" style={{ fontSize: 19 }}>Dominator Network</div>
                    <div className="wordmark-sub">Umamusume · Fan Tracker</div>
                  </div>
                </div>
                <div className="finish-ribbon" aria-hidden="true" style={{ margin: "12px 0 0" }}></div>
                <div style={{ color: "#c3a7b2", fontSize: 11, marginTop: 10, lineHeight: 1.5 }}>{dataDate.toLocaleString("en-US", { month: "long", day: "numeric", year: "numeric" })} · <span style={{ color: "#ffd0d8", fontWeight: 700 }}>Day {today}/{dim}</span><br/>{daysLeft} days left · Chronogenesis{isArchiveView ? ` · 📦 ${archiveMonth}` : ""}</div>
              </div>

              <div style={{ ...S.card, marginBottom: 0, padding: "12px 13px" }}>
                <div style={S.h2}>Navigation</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <a href="./index.html" style={navLinkStyle(PAGE_MODE === "home", "#a93f56")}>🏠 Home</a>
                  <a href="./clubs.html" style={navLinkStyle(PAGE_MODE === "clubs", "#a93f56")}>📋 Clubs</a>
                  <a href="./rankings.html" style={navLinkStyle(PAGE_MODE === "rankings", "#2563eb")}>🌐 Rankings</a>
                  <a href={clubDetailHref} style={navLinkStyle(PAGE_MODE === "club", tc.bar)}>🏇 Club Detail</a>
                  <a href={insightsHref} style={navLinkStyle(PAGE_MODE === "archives", "#f4a4b1")}>🔎 Deeper Insights</a>
                </div>
                <div style={{ marginTop: 12 }}>
                  <div style={{ color: "#ae9aa5", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 6 }}>Data Source</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    <span style={{ background: "#38202b", color: "#ffd0d8", border: "1px solid #70414f", borderRadius: 999, padding: "6px 12px", fontSize: 12, fontWeight: 800, textAlign: "center" }}>Chronogenesis</span>
                    <select value={archiveMonth} onChange={(e) => handleArchiveChange(e.target.value)} style={{ background: "rgba(21,16,21,0.72)", border: "1px solid #3b2932", color: "#f3e9ee", borderRadius: 8, padding: "8px 10px", fontSize: 11, fontWeight: 700, width: "100%" }}>
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
                          {!entry.id && <span style={{ fontSize: 9, color: "#a18c98", marginLeft: "auto" }}>soon</span>}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              <div style={{ minWidth: 0, background: "rgba(21,16,21,0.72)", border: `1px solid ${loading ? "#34d39955" : liveStatus.border}`, borderRadius: 12, padding: "10px 11px" }}>
                <div style={{ color: loading ? "#34d399" : "#f4a4b1", fontSize: 10, fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.5px" }}>{loading ? "Refreshing scheduled JSON…" : "Next scheduled refresh"}</div>
                <RefreshCountdown onCycleStart={handleScheduledRefreshCycle} style={{ color: "#f3e9ee", fontSize: 19, fontWeight: 700, lineHeight: 1.15 }} />
                <div style={{ color: "#9ca3af", fontSize: 10, marginTop: 2 }}>{nextRefreshDateLabel}</div>
                <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 2, padding: "6px 8px", borderRadius: 8, border: `1px solid ${liveStatus.border}`, background: liveStatus.bg }}>
                  <div style={{ color: liveStatus.color, fontSize: 11, fontWeight: 800 }}>{liveStatus.label}</div>
                  <div style={{ color: "#e6cfd8", fontSize: 9, lineHeight: 1.3 }}>{liveStatus.sub}</div>
                </div>
                <div style={{ color: "#ae9aa5", fontSize: 10, marginTop: 5, lineHeight: 1.25 }}>Upcoming {refreshScheduleMeta.label}: {upcomingRefreshLabel || "—"}</div>
              </div>
            </aside>

            {/* ── Track (main content) ── */}
            <main className="main">
              <div className="mobile-only" style={{ marginBottom: 12 }}>
                <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginBottom: view === "club" ? 10 : 0 }}>
                  <span style={{ background: "#1d4ed8", color: "#ffffff", border: "1px solid #3b82f6", borderRadius: 999, padding: "6px 11px", fontSize: 11, fontWeight: 800 }}>Chronogenesis</span>
                  <select value={archiveMonth} onChange={(e) => handleArchiveChange(e.target.value)} style={{ flex: 1, minWidth: 150, background: "rgba(21,16,21,0.85)", border: "1px solid #3b2932", color: "#f3e9ee", borderRadius: 8, padding: "8px 10px", fontSize: 11, fontWeight: 700 }}>
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
                  <button style={{ ...S.btn(false, weeklyCopied ? "#059669" : "#60a5fa"), ...(actionButtonDisabledStyle || {}) }} onClick={copyWeeklyDiscord} disabled={!decoratedMembers.length || resetWindowBlocksExports || discordActionsBlocked} title={actionButtonTitle}>{weeklyCopied ? (weeklyCopied === "image" ? "✓ Weekly Report + PNG" : weeklyCopied === "shared" ? "✓ Weekly Report Shared" : "✓ Weekly Report Copied!") : "📅 Generate Weekly Report + PNG"}</button>
                  <button style={{ ...S.btn(false, reminderCopied ? "#059669" : "#f59e0b"), ...(actionButtonDisabledStyle || {}) }} onClick={copyReminderDiscord} disabled={!decoratedMembers.length || resetWindowBlocksExports || discordActionsBlocked} title={actionButtonTitle}>{reminderCopied ? (reminderCopied === "image" ? "✓ Action Board + PNG" : reminderCopied === "shared" ? "✓ Action Board Shared" : "✓ Action Board Copied!") : "🚨 Generate Officer Action Board + PNG"}</button>
                  <button style={{ ...S.btn(true, copied ? "#059669" : tc.bar), ...(actionButtonDisabledStyle || {}) }} onClick={copyDiscord} disabled={!decoratedMembers.length || resetWindowBlocksExports || discordActionsBlocked} title={actionButtonTitle}>{copied ? (copied === "image" ? "✓ Daily Report + PNG" : copied === "shared" ? "✓ Daily Report Shared" : "✓ Daily Report Copied!") : "📊 Generate Daily Report + PNG"}</button>
                  <div style={{ flexBasis: "100%", marginTop: 4, padding: "12px", border: "1px solid #a855f755", borderRadius: 12, background: "#a855f70c" }}>
                    <div style={{ color: "#d8b4fe", fontSize: 10, fontWeight: 850, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8 }}>Animated Insight Story</div>
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 9 }}>
                      {[
                        { label: "Today's Performance", icon: "📈", color: "#60a5fa" },
                        { label: "Member Check-In", icon: "⚠️", color: "#fbbf24" },
                        { label: "Month-End Outlook", icon: "🔎", color: "#a78bfa" },
                      ].map((chapter, index) => (
                        <span key={chapter.label} style={{ border: `1px solid ${chapter.color}55`, background: `${chapter.color}12`, color: chapter.color, borderRadius: 999, padding: "6px 11px", fontSize: 11, fontWeight: 800 }}>
                          {index + 1} · {chapter.icon} {chapter.label}
                        </span>
                      ))}
                    </div>
                    <div style={{ display: "flex", gap: 7, flexWrap: "wrap", alignItems: "center" }}>
                      {animationBuildMode ? (
                        <button
                          style={{ ...S.btn(false, animationExportState === "error" ? "#ef4444" : animationExportState === "downloaded" ? "#059669" : "#7c3aed"), ...(actionButtonDisabledStyle || {}) }}
                          onClick={exportAnimatedDailyGif}
                          disabled={!decoratedMembers.length || resetWindowBlocksExports || discordActionsBlocked || animationExportState === "rendering"}
                          title={`Build the hosted ${getAnimationAsset().label} GIF.`}
                        >
                          {animationExportState === "rendering"
                            ? "⏳ Rendering Animated GIF…"
                            : animationExportState === "downloaded"
                              ? "✓ Hosted GIF Built"
                              : animationExportState === "error"
                                ? "⚠ GIF Failed — Try Again"
                                : "🎞️ Build Hosted Animated Insight Story"}
                        </button>
                      ) : (
                        <button
                          style={{ ...S.btn(true, ["ready-drag", "dragging-file"].includes(animationExportState) ? "#059669" : animationExportState === "error" ? "#ef4444" : "#7c3aed"), ...(actionButtonDisabledStyle || {}) }}
                          onClick={prepareAnimatedGifForDrag}
                          disabled={!decoratedMembers.length || resetWindowBlocksExports || discordActionsBlocked || isArchiveView || ["rendering", "preparing-file"].includes(animationExportState)}
                          title="Builds the current animated report and reveals a full-size copyable preview."
                        >
                          {animationExportState === "rendering"
                            ? "⏳ Building Animated Daily Report…"
                            : animationExportState === "preparing-file"
                            ? "⏳ Preparing Animated Daily Report…"
                            : animationExportState === "ready-drag"
                              ? "✓ Animated Daily Report Ready"
                              : animationExportState === "dragging-file"
                                ? "↗ Drop Animated Report into Discord"
                              : animationExportState === "error"
                                ? "⚠ Animation Failed — Try Again"
                                : "🎞️ Build Animated Daily Report"}
                        </button>
                      )}
                      {!animationBuildMode && animationDragAsset?.cacheKey === getAnimationAsset().cacheKey && (
                        <div
                          draggable
                          onDragStart={handleAnimationDragStart}
                          onDragEnd={handleAnimationDragEnd}
                          aria-label="Copy or drag the animated report into Discord"
                          title="Right-click the preview to copy it, or drag it into Discord's message box."
                          style={{
                            flexBasis: "100%",
                            maxWidth: 680,
                            padding: 12,
                            borderRadius: 11,
                            border: "1px dashed #a855f7",
                            background: "linear-gradient(135deg, #2e1065cc, #111827ee)",
                            color: "#f5e9ff",
                            cursor: "grab",
                            userSelect: "none",
                          }}
                        >
                          <img
                            src={animationDragAsset.dataUrl}
                            alt="Animated report preview"
                            draggable={false}
                            style={{ display: "block", width: "100%", aspectRatio: "16 / 9", objectFit: "cover", borderRadius: 8, border: "1px solid #7e22ce", background: "#090a14" }}
                          />
                          <div style={{ marginTop: 9 }}>
                            <div style={{ fontSize: 12, fontWeight: 900 }}>Right-click preview → Copy image → paste in Discord</div>
                            <div style={{ color: "#c4b5fd", fontSize: 10, marginTop: 3 }}>
                              You can also drag the preview into Discord · {(animationDragAsset.file.size / (1024 * 1024)).toFixed(1)} MB · no download step
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                    {!animationBuildMode && <div style={{ color: "#a8a0b8", fontSize: 10, lineHeight: 1.4, marginTop: 7 }}>Build once, then right-click the large animated preview and choose Copy image for Discord paste. Dragging the preview is available as a second self-serve option.</div>}
                  </div>
                </div>
              )}
          {err && (<div style={{ background: "#450a0a", border: "1px solid #7f1d1d", borderRadius: 12, padding: "12px 16px", marginBottom: 14, color: "#fca5a5", fontSize: 12 }}>⚠️ {err}</div>)}

          {view === "home" && (<>
            {PAGE_MODE === "home" && (<>
              <div style={S.card}>
                <div style={S.h2}>Network Home</div>
                <div style={{ color: "#f3e9ee", fontSize: 24, fontWeight: 800, marginBottom: 6 }}>Dominator Network Overview</div>
                <div style={{ color: "#c3a7b2", fontSize: 13, lineHeight: 1.6 }}>Use this page as the network-wide starting point. The live statistics below summarize every loaded club; choose a destination for the detailed views.</div>
              </div>
              <div className="stat-strip">
                {[
                  { label: "Tracked Clubs", value: `${loadedClubCount}/${viewClubs.filter((entry) => entry.id).length}`, sub: "Loaded club data", col: "#f3e9ee" },
                  { label: "Network Monthly +", value: hasComparisonData ? fmt(networkMonthlyTotal) : "—", sub: hasComparisonData ? "Across loaded clubs" : noComparisonLabel, col: hasComparisonData ? "#ffd0d8" : "#9ca3af" },
                  { label: "Network Fans", value: fmt(networkFanTotal), sub: "Active members only", col: "#34d399" },
                  { label: "Active Members", value: hasComparisonData ? networkMemberCount : "—", sub: hasComparisonData ? `${clubsMissingData} clubs missing JSON` : noComparisonLabel, col: hasComparisonData ? (clubsMissingData ? "#fbbf24" : "#34d399") : "#9ca3af" },
                  { label: `${STATUS_META["on-track"].icon} On Track`, value: hasComparisonData ? networkStatusCounts["on-track"] : "—", sub: hasComparisonData ? "Members at or above plan" : noComparisonLabel, col: STATUS_META["on-track"].color },
                  { label: `${STATUS_META["behind"].icon} Behind`, value: hasComparisonData ? networkStatusCounts["behind"] : "—", sub: hasComparisonData ? "Members below plan" : noComparisonLabel, col: STATUS_META["behind"].color },
                  { label: `${STATUS_META["critical"].icon} Critical`, value: hasComparisonData ? networkStatusCounts["critical"] : "—", sub: hasComparisonData ? "Members under 25% of plan" : noComparisonLabel, col: STATUS_META["critical"].color },
                  { label: "Members At/Above Plan", value: hasComparisonData ? `${networkMembersAtOrAbovePlan}/${networkMemberCount}` : "—", sub: hasComparisonData ? `${loadedClubCount} clubs loaded · ${clubsMissingData} missing JSON` : noComparisonLabel, col: hasComparisonData && networkMembersAtOrAbovePlan === networkMemberCount && networkMemberCount > 0 ? "#34d399" : "#ffd0d8" },
                ].map((card) => (<div key={card.label} style={{ ...S.card, marginBottom: 0, padding: "13px 15px", minWidth: 0 }}><div style={{ color: "#a18c98", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 4 }}>{card.label}</div><div style={{ color: card.col, fontSize: 22, fontWeight: 800 }}>{card.value}</div><div style={{ color: "#ae9aa5", fontSize: 11, marginTop: 3 }}>{card.sub}</div></div>))}
              </div>
              <div style={S.card}>
                <div style={S.h2}>Navigate the Tracker</div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))", gap: 12 }}>
                  {[
                    { href: "./clubs.html", icon: "📋", title: "Clubs", description: "Browse every club and open a focused high-level club summary.", color: "#a93f56" },
                    { href: "./rankings.html", icon: "🌐", title: "Rankings", description: "Explore club rankings, member leaderboards, pace, health, and movement insights.", color: "#2563eb" },
                    { href: clubDetailHref, icon: "🏇", title: "Club Detail", description: "Open the full Overview, Members, and Pace dashboard for a single club.", color: tc.bar },
                    { href: insightsHref, icon: "🔎", title: "Deeper Insights", description: "Reserved for the nerds: forecasts, stress tests, member patterns, and roster decision tools.", color: "#f4a4b1" },
                  ].map((item) => (
                    <a key={item.title} href={item.href} style={{ background: "rgba(21,16,21,0.72)", border: `1px solid ${item.color}55`, borderRadius: 14, padding: "18px", textDecoration: "none", display: "block", boxShadow: `0 0 0 1px ${item.color}11 inset` }}>
                      <div style={{ fontSize: 24, marginBottom: 10 }}>{item.icon}</div>
                      <div style={{ color: "#fff1f5", fontSize: 16, fontWeight: 800, marginBottom: 6 }}>{item.title}</div>
                      <div style={{ color: "#c3a7b2", fontSize: 12, lineHeight: 1.55 }}>{item.description}</div>
                    </a>
                  ))}
                </div>
              </div>
            </>)}

            {PAGE_MODE === "clubs" && (<>
              <div style={S.card}>
                <div style={S.h2}>Club Directory</div>
                <div style={{ color: "#ae9aa5", fontSize: 12, marginBottom: 12 }}>Hover the pace bar for exact figures. The dot next to JSON shows load status.</div>
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
                        style={{ borderLeft: `3px solid ${entry.hasData ? ctc.border : "#3b2932"}` }}
                      >
                        <div className="dir-id">
                          <span className="gate-num" style={{ borderColor: entry.hasData ? ctc.border + "66" : undefined }}>{index + 1}</span>
                          <TierBadge tier={entry.tier} rankingConfig={viewRankingConfig} rankIconPath={viewRankIconPath} />
                        </div>
                        <div className="dir-name">
                          <div style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0 }}>
                            <span style={{ fontWeight: 800, color: "#fff1f5", fontSize: 14, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{entry.clubName}</span>
                            {entry.currentMonthlyRank != null && <MonthlyRankBadge rank={entry.currentMonthlyRank} delta={entry.rankDelta} size="small" rankingConfig={viewRankingConfig} rankIconPath={viewRankIconPath} />}
                          </div>
                          <div style={{ color: "#ae9aa5", fontSize: 10, marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{entry.officer} · <span style={{ color: ctc.text, fontWeight: 700 }}>{fmt(entry.target)}</span>/member · {hasComparisonData ? `${entry.activeMembers}/${viewMaxMembers} active` : noComparisonLabel}</div>
                        </div>
                        <div className="dir-stats">
                          <div>
                            <div className="dir-stat-label">Monthly</div>
                            <div style={{ color: entry.hasData && hasComparisonData ? "#fff1f5" : "#9ca3af", fontWeight: 800, fontSize: 13 }}>{entry.hasData && hasComparisonData ? fmt(entry.totalMonthly) : "—"}</div>
                            {planDelta != null && <div style={{ color: onPace ? "#34d399" : "#f87171", fontSize: 10, fontWeight: 700 }}>{fmtSigned(planDelta)} vs plan</div>}
                          </div>
                          <div>
                            <div className="dir-stat-label">Daily</div>
                            <div style={{ color: entry.hasData && entry.totalDaily != null ? "#e6cfd8" : "#9ca3af", fontWeight: 800, fontSize: 13 }}>{entry.hasData && entry.totalDaily != null ? fmt(entry.totalDaily) : "—"}</div>
                            {entry.hasData && hasComparisonData ? <DailyTrendIndicator delta={entry.dailyTrendDelta} /> : null}
                          </div>
                          <div>
                            <div className="dir-stat-label">Prev Day</div>
                            <div style={{ color: entry.hasData && entry.previousDaily != null ? "#ffd0d8" : "#9ca3af", fontWeight: 800, fontSize: 13 }}>{entry.hasData && entry.previousDaily != null ? fmt(entry.previousDaily) : "—"}</div>
                            {entry.hasData && today > 1 && <div style={{ color: "#b391a0", fontSize: 10 }}>Day {today - 1}</div>}
                          </div>
                        </div>
                        <div className="dir-actions">
                          <span title={entry.jsonMeta.sub} style={{ display: "inline-flex", alignItems: "center", gap: 5, color: entry.jsonMeta.color, fontSize: 10, fontWeight: 700, whiteSpace: "nowrap" }}>
                            <span style={{ width: 7, height: 7, borderRadius: 999, background: entry.jsonMeta.color, boxShadow: `0 0 6px ${entry.jsonMeta.color}`, flexShrink: 0 }} />JSON
                          </span>
                          <span className="dir-select-label" style={{ color: clubsPageSelectedIdx === index ? ctc.text : "#c3a7b2", borderColor: clubsPageSelectedIdx === index ? `${ctc.border}88` : undefined }}>{clubsPageSelectedIdx === index ? "Selected" : "Select club"}</span>
                        </div>
                        <div className="dir-bar" title={entry.hasData && hasComparisonData ? `${fmtFull(entry.totalMonthly)} of ${fmtFull(entry.clubTarget)} club target (${monthPct.toFixed(1)}%)` : "No data yet"}>
                          <div style={{ flex: 1 }}><ProgressBar pct={monthPct} color={onPace ? "#34d399" : entry.hasData && hasComparisonData ? "#f59e0b" : "#50333f"} height={5} /></div>
                          <span className="telemetry" style={{ color: entry.hasData && hasComparisonData ? (onPace ? "#34d399" : "#fbbf24") : "#b391a0", fontSize: 11, fontWeight: 700, minWidth: 44, textAlign: "right" }}>{entry.hasData && hasComparisonData ? `${monthPct.toFixed(1)}%` : "—"}</span>
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
                          <span style={{ color: "#fff1f5", fontSize: 21, fontWeight: 800 }}>{entry.clubName}</span>
                          {entry.currentMonthlyRank != null && <MonthlyRankBadge rank={entry.currentMonthlyRank} delta={entry.rankDelta} rankingConfig={viewRankingConfig} rankIconPath={viewRankIconPath} />}
                        </div>
                        <div style={{ color: "#c3a7b2", fontSize: 11, marginTop: 6 }}>{entry.officer} · {fmt(entry.target)} per member · Club ID {entry.id}</div>
                      </div>
                      <button style={S.btn(true, ctc.bar)} onClick={() => openClub(clubsPageSelectedIdx)}>Open full club detail →</button>
                    </div>
                    {!entry.hasData ? (
                      <div style={{ background: "rgba(21,16,21,0.72)", border: "1px solid #3b2932", borderRadius: 12, padding: "16px", color: "#c3a7b2", fontSize: 12 }}>No Chronogenesis JSON is currently loaded for this club.</div>
                    ) : (
                      <>
                        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(145px, 1fr))", gap: 10, marginBottom: 14 }}>
                          {[
                            { label: "Active Members", value: `${entry.activeMembers}/${viewMaxMembers}`, col: "#f3e9ee" },
                            { label: "Monthly Gain", value: hasComparisonData ? fmt(entry.totalMonthly) : "—", col: "#ffd0d8" },
                            { label: "Daily Gain", value: entry.totalDaily != null ? fmt(entry.totalDaily) : "—", col: "#f3e9ee" },
                            { label: "Projected", value: hasComparisonData ? fmt(entry.totalProjected) : "—", col: "#f4a4b1" },
                            { label: "Total Fans", value: fmt(entry.totalFans), col: "#34d399" },
                            { label: "Health", value: hasComparisonData ? `${entry.health.grade} · ${entry.health.score}` : "—", col: hasComparisonData ? entry.health.color : "#9ca3af" },
                          ].map((item) => (<div key={item.label} style={{ background: "rgba(21,16,21,0.72)", border: "1px solid #3b2932", borderRadius: 11, padding: "11px 13px" }}><div style={{ color: "#a18c98", fontSize: 9, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 4 }}>{item.label}</div><div style={{ color: item.col, fontSize: 17, fontWeight: 800 }}>{item.value}</div></div>))}
                        </div>
                        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 10, marginBottom: 14 }}>
                          {["on-track", "behind", "critical"].map((statusKey) => { const meta = STATUS_META[statusKey]; return (<div key={statusKey} style={{ background: meta.bg, border: `1px solid ${meta.border}`, borderRadius: 10, padding: "10px 12px" }}><div style={{ color: meta.color, fontSize: 11, fontWeight: 800 }}>{meta.icon} {meta.label}</div><div style={{ color: "#fff1f5", fontSize: 18, fontWeight: 800, marginTop: 3 }}>{hasComparisonData ? entry.statusCounts[statusKey] : "—"}</div></div>); })}
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
                <div style={{ color: "#f3e9ee", fontSize: 22, fontWeight: 800, marginBottom: 6 }}>Club and Individual Ranking Insights</div>
                <div style={{ color: "#c3a7b2", fontSize: 12, lineHeight: 1.6 }}>Choose a focused view for network trends, club-level comparisons, or individual member rankings.</div>
              </div>

              <div className="tab-dock" aria-label="Ranking sections">
                {[
                  ["home", "🏠 Rankings Home"],
                  ["clubs", "🏇 Club Rankings"],
                  ["individual", "👤 Individual Rankings"],
                ].map(([sectionKey, label]) => (
                  <button
                    key={sectionKey}
                    style={S.btn(rankingsTab === sectionKey, rankingsTab === sectionKey ? "#a93f56" : undefined)}
                    onClick={() => selectRankingsTab(sectionKey)}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {rankingsTab === "clubs" && (<div id="club-rankings-section" style={S.card}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap", marginBottom: 12 }}>
                  <div><div style={S.h2}>Club Rankings</div><div style={{ color: "#c3a7b2", fontSize: 12, lineHeight: 1.6, maxWidth: 760 }}>Compare global rank, progress toward each club’s quota, projected month-end result, member readiness, and health. Clubs remain ordered by their global monthly rank.</div></div>
                  <div style={{ background: "#261c23", border: "1px solid #50333f", borderRadius: 999, padding: "7px 10px", color: "#ffd0d8", fontSize: 10, fontWeight: 800 }}>{forecastReadyClubs.length} forecast-ready · {partialHistoryClubs.length} partial</div>
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 9, marginBottom: 12 }}>
                  {[
                    { label: "Best global rank", value: bestRankedClub ? `#${bestRankedClub.currentMonthlyRank}` : "—", sub: bestRankedClub?.clubName || "No rank available", color: "#fbbf24" },
                    { label: "Biggest rank gain", value: strongestRankMover ? `+${strongestRankMover.rankDelta}` : "—", sub: strongestRankMover ? `${strongestRankMover.clubName} places gained` : "No club moved up today", color: "#34d399" },
                    { label: "Strongest target outlook", value: strongestOutlookClub ? `${Math.round(strongestOutlookClub.projectedRatio * 100)}%` : "—", sub: strongestOutlookClub ? `${strongestOutlookClub.clubName} projected vs quota` : "No reliable forecast yet", color: "#f4a4b1" },
                    { label: "Health leader", value: healthiestClub ? `${healthiestClub.health.score}/100` : "—", sub: healthiestClub?.clubName || "No reliable health score", color: healthiestClub?.health.color || "#9ca3af" },
                  ].map((item) => (<div key={item.label} style={{ background: "rgba(21,16,21,0.72)", border: "1px solid #3b2932", borderRadius: 11, padding: "11px 13px" }}><div style={{ color: "#ae9aa5", fontSize: 9, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 4 }}>{item.label}</div><div style={{ color: item.color, fontSize: 19, fontWeight: 900 }}>{item.value}</div><div style={{ color: "#c3a7b2", fontSize: 10, marginTop: 3 }}>{item.sub}</div></div>))}
                </div>

                <div style={{ background: clubsAtRisk.length ? "rgba(120,53,15,0.16)" : "rgba(6,78,59,0.16)", border: `1px solid ${clubsAtRisk.length ? "#f59e0b44" : "#34d39944"}`, borderRadius: 11, padding: "11px 13px", marginBottom: 14 }}>
                  <div style={{ color: clubsAtRisk.length ? "#fbbf24" : "#34d399", fontSize: 11, fontWeight: 900, marginBottom: 4 }}>What matters now</div>
                  <div style={{ color: "#d5d2e5", fontSize: 11, lineHeight: 1.6 }}>{clubsProjectedToGoal.length} of {forecastReadyClubs.length} forecast-ready clubs are projected to meet quota; {clubsAheadOfPlan.length} are currently at or above elapsed-month plan. {clubsAtRisk.length ? `${clubsAtRisk.length} club${clubsAtRisk.length === 1 ? " is" : "s are"} projected below 90% and need attention.` : "No forecast-ready club is currently projected below 90%."}{weakestOutlookClub ? ` The weakest current outlook is ${weakestOutlookClub.clubName} at ${Math.round(weakestOutlookClub.projectedRatio * 100)}%.` : ""}</div>
                </div>

                {partialHistoryClubs.length > 0 && (<div style={{ background: "rgba(55,65,81,0.22)", border: "1px solid #a18c9844", borderRadius: 10, padding: "9px 11px", color: "#9ca3af", fontSize: 10, lineHeight: 1.55, marginBottom: 12 }}><b style={{ color: "#d1d5db" }}>Partial data:</b> {partialHistoryClubs.map((entry) => entry.clubName).join(", ")} {partialHistoryClubs.length === 1 ? "is" : "are"} shown in the table, but forecast and health judgments are withheld because fewer than 70% of current members have near-full-month history in that club. This avoids treating recent transfers or a newly added club as poor performance.</div>)}

                <div style={{ overflowX: "auto" }}><table style={{ width: "100%", borderCollapse: "collapse", minWidth: 1080 }}><thead><tr style={{ textAlign: "left" }}><th style={S.th}>Global Monthly Rank — Current / Projected</th><th style={S.th}>Club / Quota Tier</th><th style={S.th}>Goal Progress</th><th style={S.th}>Month-End Outlook</th><th style={S.th}>Members On Pace</th><th style={S.th}>Health</th><th style={S.th}>Detail</th></tr></thead><tbody>
                  {rankedNetworkClubs.length === 0 ? (<tr><td colSpan={7} style={{ ...S.td, textAlign: "center", color: "#ae9aa5", padding: "22px 8px" }}>No club ranking data is available yet.</td></tr>) : rankedNetworkClubs.map((entry) => {
                    const outlook = getClubOutlookMeta(entry);
                    const progressRatio = entry.clubTarget > 0 ? entry.totalMonthly / entry.clubTarget : 0;
                    const officialRankForecast = officialRankForecastByClubId[entry.id];
                    const projectedOfficialTier = officialRankForecast ? getTierForRank(officialRankForecast.rank, viewRankingConfig) : null;
                    return (<tr key={`club-rank-${entry.id}`}>
                      <td style={S.td}>
                        <div style={{ marginBottom: 6 }}>{entry.currentMonthlyRank != null ? <MonthlyRankBadge rank={entry.currentMonthlyRank} delta={entry.rankDelta} rankingConfig={viewRankingConfig} rankIconPath={viewRankIconPath} /> : <span style={{ color: "#ae9aa5" }}>Current rank —</span>}</div>
                        {officialRankForecast ? (
                          <div title={`90% global quota-derived rank (${officialRankForecast.thresholdRank}) and 10% recent rank-movement estimate (${officialRankForecast.historicalRank ?? "unavailable"}).`} style={{ display: "flex", alignItems: "center", gap: 5, color: "#ffd0d8", fontSize: 10, fontWeight: 800 }}>
                            {projectedOfficialTier && <TierIcon tier={projectedOfficialTier} size={14} showFallbackText={false} rankingConfig={viewRankingConfig} rankIconPath={viewRankIconPath} />}
                            Projected ≈ #{officialRankForecast.rank.toLocaleString()}
                            <span style={{ color: "#ae9aa5", fontWeight: 600 }}>· {officialRankForecast.confidence}</span>
                          </div>
                        ) : (
                          <div style={{ color: "#ae9aa5", fontSize: 9, lineHeight: 1.4 }}>{rankThresholdForecast.ready ? "Projected rank unavailable for partial club data" : "Projected rank waiting for threshold history"}</div>
                        )}
                      </td>
                      <td style={S.td}><div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 3 }}><TierBadge tier={entry.tier} rankingConfig={viewRankingConfig} rankIconPath={viewRankIconPath} /><span style={{ color: "#f3e9ee", fontWeight: 800 }}>{entry.clubName}</span></div><div style={{ color: "#ae9aa5", fontSize: 9 }}>{entry.tier} quota · {fmt(entry.target)} per member</div></td>
                      <td style={S.td}><div style={{ color: entry.hasReliableHistory ? gainColor(entry.totalMonthly) : "#9ca3af", fontWeight: 800 }}>{hasComparisonData ? fmt(entry.totalMonthly) : "—"}</div><div style={{ width: 130, margin: "6px 0 4px" }}><ProgressBar pct={progressRatio * 100} color={entry.hasReliableHistory ? (progressRatio >= (today / dim) ? "#34d399" : "#f59e0b") : "#ae9aa5"} height={5} /></div><div style={{ color: "#ae9aa5", fontSize: 9 }}>{hasComparisonData ? `${Math.round(progressRatio * 100)}% of ${fmt(entry.clubTarget)}` : noComparisonLabel}</div></td>
                      <td style={S.td}><div style={{ display: "inline-flex", background: outlook.bg, border: `1px solid ${outlook.border}`, color: outlook.color, borderRadius: 999, padding: "4px 7px", fontSize: 9, fontWeight: 900, marginBottom: 5 }}>{outlook.label}</div><div style={{ color: entry.hasReliableHistory ? "#ffd0d8" : "#ae9aa5", fontWeight: 800 }}>{entry.hasReliableHistory ? fmt(entry.totalProjected) : "Forecast withheld"}</div><div style={{ color: "#ae9aa5", fontSize: 9, marginTop: 2 }}>{entry.hasReliableHistory ? `${Math.round(entry.projectedRatio * 100)}% of quota` : `${entry.historyEligibleMembers}/${entry.activeMembers} members have usable history`}</div></td>
                      <td style={S.td}><div style={{ color: entry.hasReliableHistory ? "#34d399" : "#9ca3af", fontWeight: 900 }}>{entry.hasReliableHistory ? `${entry.statusCounts["on-track"]}/${entry.activeMembers}` : "—"}</div><div style={{ color: "#ae9aa5", fontSize: 9, marginTop: 3 }}>{entry.hasReliableHistory ? `${Math.round(entry.pctOnTrack * 100)}% currently on pace` : "Not scored on partial data"}</div></td>
                      <td style={S.td}>{entry.hasReliableHistory ? <><HealthBadge grade={entry.health.grade} /><div style={{ color: entry.health.color, fontSize: 9, fontWeight: 800, marginTop: 4 }}>{entry.health.score}/100</div></> : <span style={{ color: "#ae9aa5", fontSize: 10 }}>Not scored</span>}</td>
                      <td style={S.td}><a href={`./club.html?id=${encodeURIComponent(entry.id)}${archiveMonth ? `&month=${encodeURIComponent(archiveMonth)}` : ""}`} style={{ ...S.btn(false, entry.clubColor), display: "inline-flex", textDecoration: "none" }}>Open →</a></td>
                    </tr>);
                  })}
                </tbody></table></div>
              </div>)}

              {rankingsTab === "individual" && (<div id="individual-member-rankings" style={S.card}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center", flexWrap: "wrap", marginBottom: 8 }}><div><div style={S.h2}>Individual Member Rankings</div><div style={{ color: "#c3a7b2", fontSize: 12, lineHeight: 1.55 }}>Compare raw fan production with each member’s club-specific quota. Rankings measure output—not automatic promotion or transfer decisions.</div></div><div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}><select value={networkMemberClubFilter} onChange={(event) => setNetworkMemberClubFilter(event.target.value)} style={{ background: "#151115", border: "1px solid #50333f", color: "#f3e9ee", borderRadius: 999, padding: "7px 10px", fontSize: 10 }}><option value="all">All clubs</option>{networkClubs.filter((entry) => entry.hasData).map((entry) => <option key={entry.id} value={entry.clubName}>{entry.clubName}</option>)}</select><button style={S.btn(topNetworkMode === "daily", "#a93f56")} onClick={() => setTopNetworkMode("daily")}>Daily Gain</button><button style={S.btn(topNetworkMode === "monthly", "#a93f56")} onClick={() => setTopNetworkMode("monthly")}>Monthly Gain</button></div></div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(165px,1fr))", gap: 9, margin: "12px 0" }}>
                  {[
                    { label: topNetworkMode === "daily" ? "Daily leader" : "Monthly leader", value: topNetworkUsers[0]?.name || "—", sub: topNetworkUsers[0] ? `${topNetworkUsers[0].clubName} · ${fmt(topNetworkMode === "daily" ? topNetworkUsers[0].dailyGain : topNetworkUsers[0].monthlyGain)}` : "No member data", color: "#fbbf24" },
                    { label: "Projected to quota", value: `${individualQuotaHitters}/${individualRankPool.length}`, sub: "Using each member’s current club quota", color: "#34d399" },
                    { label: "Projected at 125%+", value: individualHighOutlook, sub: "Strong output signal; not a transfer verdict", color: "#f4a4b1" },
                    { label: "Top-25 club breadth", value: `${representedTopClubs} clubs`, sub: networkMemberClubFilter === "all" ? "Clubs represented among visible leaders" : `Filtered to ${networkMemberClubFilter}`, color: "#60a5fa" },
                  ].map((item) => <div key={item.label} style={{ background: "rgba(21,16,21,0.72)", border: "1px solid #3b2932", borderRadius: 11, padding: "11px 13px" }}><div style={{ color: "#ae9aa5", fontSize: 9, textTransform: "uppercase", letterSpacing: "0.08em" }}>{item.label}</div><div style={{ color: item.color, fontWeight: 900, fontSize: 17, marginTop: 4 }}>{item.value}</div><div style={{ color: "#c3a7b2", fontSize: 9, marginTop: 3 }}>{item.sub}</div></div>)}
                </div>
                {hasComparisonData && topNetworkUsers.length > 0 && (<div style={{ color: "#c3a7b2", fontSize: 11, marginBottom: 12 }}>Showing the top {visibleNetworkUsers.length} of {topNetworkUsers.length} members.</div>)}
                {hasComparisonData && topNetworkUsers.length > 0 && (
                  <div className="podium">
                    {topNetworkUsers.slice(0, 3).map((member, index) => {
                      const ps = getPodiumStyle(index);
                      const value = topNetworkMode === "daily" ? member.dailyGain : member.monthlyGain;
                      return (
                        <div key={`podium-${member.clubName}-${member.name}`} className={`podium-step podium-${index + 1}`}>
                          <div className="podium-rank" style={{ color: ps.color, textShadow: ps.textShadow }}>{index === 0 ? "🥇" : index === 1 ? "🥈" : "🥉"}</div>
                          <div style={{ color: "#fff1f5", fontWeight: 800, fontSize: index === 0 ? 14 : 12, marginTop: 6, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{member.name}</div>
                          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 5, marginTop: 4, color: "#c3a7b2", fontSize: 10, minWidth: 0 }}><TierBadge tier={member.clubTier} size={14} rankingConfig={viewRankingConfig} rankIconPath={viewRankIconPath} /><span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{member.clubName}</span></div>
                          <div className="telemetry" style={{ color: ps.color, fontWeight: 700, fontSize: index === 0 ? 18 : 15, marginTop: 7 }}>{value != null ? fmtSigned(value) : "—"}</div>
                          <div style={{ color: "#ae9aa5", fontSize: 9, marginTop: 2 }}>{fmt(member.fans)} total fans</div>
                        </div>
                      );
                    })}
                  </div>
                )}
                <div style={{ overflowX: "auto" }}><table style={{ width: "100%", borderCollapse: "collapse", minWidth: 850 }}><thead><tr style={{ textAlign: "left" }}><th style={S.th}>#</th><th style={S.th}>Member</th><th style={S.th}>Club</th>{topNetworkMode === "daily" ? <th style={S.th}>Daily Gain</th> : <th style={S.th}>Monthly Fans</th>}<th style={S.th}>Projected Finish</th><th style={S.th}>Quota Outlook</th><th style={S.th}>Total Fans</th></tr></thead><tbody>
                  {!hasComparisonData ? (<tr><td colSpan={7} style={{ ...S.td, textAlign: "center", color: "#ae9aa5", padding: "22px 8px" }}>{noComparisonLabel}</td></tr>) : topNetworkUsers.length === 0 ? (<tr><td colSpan={7} style={{ ...S.td, textAlign: "center", color: "#ae9aa5", padding: "22px 8px" }}>No members match the selected club filter.</td></tr>) : (
                    visibleNetworkUsers.slice(3).map((member, index) => { const quotaRatio = member.clubTarget > 0 ? (member.projected ?? 0) / member.clubTarget : 0; const quotaColor = quotaRatio >= 1.25 ? "#f4a4b1" : quotaRatio >= 1 ? "#34d399" : quotaRatio >= 0.9 ? "#fbbf24" : "#f87171"; return (<tr key={`${member.clubName}-${member.name}-${index}`}><td style={{ ...S.td, color: "#ae9aa5" }}>{index + 4}</td><td style={{ ...S.td, color: "#f3e9ee", fontWeight: 700 }}>{member.name}</td><td style={S.td}><div style={{ display: "flex", alignItems: "center", gap: 8 }}><TierBadge tier={member.clubTier} rankingConfig={viewRankingConfig} rankIconPath={viewRankIconPath} /><span>{member.clubName}</span></div></td>{topNetworkMode === "daily" ? (<td style={{ ...S.td, color: gainColor(member.dailyGain), fontWeight: 700 }}>{member.dailyGain != null ? fmtSigned(member.dailyGain) : "—"}</td>) : (<td style={{ ...S.td, color: gainColor(member.monthlyGain), fontWeight: 700 }}>{fmtSigned(member.monthlyGain ?? 0)}</td>)}<td style={{ ...S.td, color: "#ffd0d8", fontWeight: 800 }}>{fmt(member.projected)}</td><td style={{ ...S.td, color: quotaColor, fontWeight: 900 }}>{Math.round(quotaRatio * 100)}% <span style={{ color: "#ae9aa5", fontSize: 9 }}>of {fmt(member.clubTarget)}</span></td><td style={{ ...S.td, color: "#f3e9ee", fontWeight: 700 }}>{fmtFull(member.fans)}</td></tr>); })
                  )}
                </tbody></table></div>
                {topNetworkUsers.length > RANKINGS_MEMBER_DEFAULT_COUNT && (
                  <div style={{ display: "flex", justifyContent: "center", marginTop: 12 }}>
                    {remainingNetworkUserCount > 0 ? (
                      <button
                        style={S.btn(false, "#a93f56")}
                        onClick={() => setNetworkMemberVisibleCount((previousCount) => Math.min(topNetworkUsers.length, previousCount + RANKINGS_MEMBER_PAGE_SIZE))}
                      >
                        Show next {Math.min(RANKINGS_MEMBER_PAGE_SIZE, remainingNetworkUserCount)} members
                      </button>
                    ) : (
                      <button style={S.btn(false, "#a93f56")} onClick={() => setNetworkMemberVisibleCount(RANKINGS_MEMBER_DEFAULT_COUNT)}>
                        Hide {hiddenOnNetworkResetCount} members
                      </button>
                    )}
                  </div>
                )}
              </div>)}

              {rankingsTab === "clubs" && (<div id="top-five-by-club" style={S.card}>
                <div style={S.h2}>Top Five Players by Club</div>
                <div style={{ color: "#ae9aa5", fontSize: 12, marginBottom: 12 }}>Top five monthly fan gainers in each loaded club, with daily gain for quick comparison.</div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 10 }}>
                  {networkClubs.filter((entry) => entry.id).map((entry) => {
                    const ctc = viewTierColors[entry.tier] || viewTierColors["B+"];
                    return (
                      <div key={`top-five-${entry.name}`} style={{ background: "rgba(21,16,21,0.72)", border: `1px solid ${entry.hasData ? ctc.border + "55" : "#3b2932"}`, borderRadius: 12, padding: "13px 14px" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center", marginBottom: 10 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 8 }}><TierBadge tier={entry.tier} rankingConfig={viewRankingConfig} rankIconPath={viewRankIconPath} /><div style={{ color: "#f3e9ee", fontWeight: 800, fontSize: 14 }}>{entry.clubName}</div></div>
                          <div style={{ color: "#ae9aa5", fontSize: 10 }}>{hasComparisonData ? `${entry.activeMembers} active` : noComparisonLabel}</div>
                        </div>
                        {!entry.hasData ? (<div style={{ color: "#ae9aa5", fontSize: 12, padding: "8px 0" }}>No JSON loaded for this club yet.</div>) : !hasComparisonData ? (<div style={{ color: "#ae9aa5", fontSize: 12, padding: "8px 0" }}>{noComparisonLabel}</div>) : entry.topFiveMembers.length === 0 ? (<div style={{ color: "#ae9aa5", fontSize: 12, padding: "8px 0" }}>No active members available.</div>) : (
                          <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                            <div style={{ display: "grid", gridTemplateColumns: "28px minmax(0, 1fr) auto auto", gap: 8, alignItems: "center", color: "#ae9aa5", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em" }}><div>#</div><div>Member</div><div>Day</div><div>Month</div></div>
                            {entry.topFiveMembers.map((member, index) => { const podiumStyle = getPodiumStyle(index); return (<div key={`${entry.clubName}-${member.name}-${index}`} style={{ display: "grid", gridTemplateColumns: "28px minmax(0, 1fr) auto auto", gap: 8, alignItems: "center" }}><div style={{ color: podiumStyle.color, textShadow: podiumStyle.textShadow, fontSize: 11, fontWeight: 800 }}>#{index + 1}</div><div style={{ color: podiumStyle.color, textShadow: podiumStyle.textShadow, fontWeight: 800, fontSize: 12, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{member.name}</div><div style={{ color: gainColor(member.dailyGain), fontWeight: 700, fontSize: 11 }}>{member.dailyGain != null ? fmtSigned(member.dailyGain) : "—"}</div><div style={{ color: gainColor(member.monthlyGain), fontWeight: 700, fontSize: 11 }}>{fmtSigned(member.monthlyGain ?? 0)}</div></div>); })}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>)}

              {rankingsTab === "clubs" && (<div id="network-critical-members" style={S.card}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center", flexWrap: "wrap", marginBottom: 8 }}><div style={S.h2}>Network Critical Members</div><div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}><button style={S.btn(criticalClubFilter === "all", "#a93f56")} onClick={() => setCriticalClubFilter("all")}>All Clubs</button>{criticalClubOptions.map((cn) => (<button key={cn} style={S.btn(criticalClubFilter === cn, "#a93f56")} onClick={() => setCriticalClubFilter(cn)}>{cn}</button>))}</div></div>
                <div style={{ color: "#ae9aa5", fontSize: 12, marginBottom: 12 }}>Members currently in critical status across all loaded clubs. All metrics reflect data through {dataDate.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}.</div>
                <div style={{ overflowX: "auto" }}><table style={{ width: "100%", borderCollapse: "collapse" }}><thead><tr style={{ textAlign: "left" }}><th style={S.th}>Member</th><th style={S.th}>Club</th><th style={{ ...S.th, cursor: "pointer" }} onClick={() => toggleCriticalSort("planDelta")}>Vs Weekly Plan {criticalSortLabel("planDelta")}</th><th style={{ ...S.th, cursor: "pointer" }} onClick={() => toggleCriticalSort("rolling3DayAvg")}>3-Day Avg {criticalSortLabel("rolling3DayAvg")}</th><th style={{ ...S.th, cursor: "pointer" }} onClick={() => toggleCriticalSort("projected")}>Projected Fans {criticalSortLabel("projected")}</th><th style={{ ...S.th, cursor: "pointer" }} onClick={() => toggleCriticalSort("fansNeeded")}>Needed for Month-End Plan {criticalSortLabel("fansNeeded")}</th><th style={S.th}>Idle</th></tr></thead><tbody>
                  {!hasComparisonData ? (<tr><td colSpan={7} style={{ ...S.td, textAlign: "center", color: "#ae9aa5", padding: "22px 8px" }}>{noComparisonLabel}</td></tr>) : criticalNetworkMembers.length === 0 ? (<tr><td colSpan={7} style={{ ...S.td, textAlign: "center", color: "#ae9aa5", padding: "22px 8px" }}>No members are currently in critical status across the selected clubs.</td></tr>) : (
                    visibleCriticalMembers.map((member, index) => (<tr key={`critical-${member.clubName}-${member.name}-${index}`}><td style={{ ...S.td, color: "#f3e9ee", fontWeight: 700 }}>{member.name}</td><td style={S.td}><div style={{ display: "flex", alignItems: "center", gap: 8 }}><TierBadge tier={member.clubTier} rankingConfig={viewRankingConfig} rankIconPath={viewRankIconPath} /><span>{member.clubName}</span></div></td><td style={{ ...S.td, color: STATUS_META["critical"].color, fontWeight: 700 }}>{deltaText(member.plan.delta)}</td><td style={{ ...S.td, color: criticalAvgColor(member.rolling3DayAvg ?? 0), fontWeight: 700 }}>{fmtSigned(member.rolling3DayAvg)}</td><td style={{ ...S.td, color: "#ffd0d8", fontWeight: 700 }}>{fmt(member.projected ?? 0)}</td><td style={{ ...S.td, color: "#f3e9ee", fontWeight: 700 }}>{fmt(member.fansNeededForPlan)}</td><td style={S.td}><StagnantBadge days={member.stagnantDays} /></td></tr>))
                  )}
                </tbody></table></div>
                {hasComparisonData && remainingCriticalCount > 0 && (<div style={{ position: "sticky", bottom: 0, paddingTop: 12, marginTop: -6, background: "linear-gradient(to bottom, rgba(10,9,18,0), rgba(10,9,18,0.96) 45%, rgba(10,9,18,1) 100%)", display: "flex", justifyContent: "center" }}><button style={S.btn(false, "#a93f56")} onClick={() => setCriticalVisibleCount((prev) => prev + 10)}>Show {Math.min(10, remainingCriticalCount)} More</button></div>)}
              </div>)}
            </>)}

            {PAGE_MODE === "rankings" && (<>
              {rankingsTab === "clubs" && (<div id="club-health-scores" style={S.card}>
                <div style={S.h2}>Club Health Scores</div>
                <div style={{ color: "#ae9aa5", fontSize: 12, marginBottom: 14 }}>Composite score: % on track (40%) + projected vs target (35%) + member activity (25%).</div>
                {!hasComparisonData ? (<div style={{ background: "rgba(21,16,21,0.72)", border: "1px solid #3b2932", borderRadius: 12, padding: "14px 16px", color: "#ae9aa5", fontSize: 12 }}>{noComparisonLabel}</div>) : (
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 10 }}>
                    {networkClubs.filter((e) => e.hasData).sort((a, b) => b.health.score - a.health.score).map((entry) => (
                      <div key={`hs-${entry.name}`} style={{ background: "rgba(21,16,21,0.72)", border: `1px solid ${entry.health.color}44`, borderRadius: 12, padding: "14px" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10, marginBottom: 10 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                            <TierBadge tier={entry.tier} rankingConfig={viewRankingConfig} rankIconPath={viewRankIconPath} />
                            <div>
                              <div style={{ color: "#f3e9ee", fontWeight: 800, fontSize: 14 }}>{entry.clubName}</div>
                              <div style={{ color: "#ae9aa5", fontSize: 10, marginTop: 2 }}>{entry.activeMembers} members · {entry.health.score}/100 composite</div>
                            </div>
                          </div>
                          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6, flexShrink: 0 }}>
                            <HealthBadge grade={entry.health.grade} />
                            <span style={{ color: entry.health.color, fontSize: 11, fontWeight: 800 }}>{entry.health.score}%</span>
                          </div>
                        </div>
                        <div style={{ marginBottom: 10 }}><ProgressBar pct={entry.health.score} color={entry.health.color} height={7} /></div>
                        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 8, marginBottom: 10, fontSize: 11 }}>
                          <div style={{ background: "#151115", border: "1px solid #3b2932", borderRadius: 10, padding: "10px" }}><div style={{ color: "#a18c98", fontSize: 9, textTransform: "uppercase", marginBottom: 3 }}>On-track members</div><div style={{ color: "#34d399", fontWeight: 800 }}>{entry.statusCounts["on-track"]}/{entry.activeMembers}</div></div>
                          <div style={{ background: "#151115", border: "1px solid #3b2932", borderRadius: 10, padding: "10px" }}><div style={{ color: "#a18c98", fontSize: 9, textTransform: "uppercase", marginBottom: 3 }}>Projected monthly</div><div style={{ color: "#ffd0d8", fontWeight: 800 }}>{fmt(entry.totalProjected)}</div></div>
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
              <div id="rankings-network-summary" style={S.card}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap", marginBottom: 12 }}>
                  <div><div style={S.h2}>Network Ranking Pulse</div><div style={{ color: "#c3a7b2", fontSize: 12, lineHeight: 1.6, maxWidth: 760 }}>Use this page to answer four questions quickly: how many clubs are on pace, who is leading, which direction ranks are moving, and where officer attention is most useful.</div></div>
                  <div style={{ background: "#261c23", border: "1px solid #50333f", borderRadius: 999, padding: "7px 10px", color: "#ffd0d8", fontSize: 10, fontWeight: 800 }}>Through Day {today}</div>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 9, marginBottom: 13 }}>
                  {[
                    { label: "Forecast coverage", value: `${forecastReadyClubs.length}/${loadedClubCount}`, sub: partialHistoryClubs.length ? `${partialHistoryClubs.length} partial-data club${partialHistoryClubs.length === 1 ? "" : "s"} excluded` : "All loaded clubs are forecast-ready", color: partialHistoryClubs.length ? "#fbbf24" : "#34d399" },
                    { label: "Projected to goal", value: `${clubsProjectedToGoal.length}/${forecastReadyClubs.length}`, sub: "Forecast-ready clubs at 100%+", color: clubsProjectedToGoal.length === forecastReadyClubs.length && forecastReadyClubs.length ? "#34d399" : "#60a5fa" },
                    { label: "Ahead of elapsed plan", value: `${clubsAheadOfPlan.length}/${forecastReadyClubs.length}`, sub: `Actual gain compared with Day ${today} target`, color: "#2dd4bf" },
                    { label: "Network month-end outlook", value: forecastReadyClubs.length ? `${Math.round(networkProjectedRatio * 100)}%` : "—", sub: forecastReadyClubs.length ? `${fmt(networkProjectedTotal)} projected vs ${fmt(networkClubTargetTotal)} quota` : "No reliable forecast yet", color: networkProjectedRatio >= 1 ? "#34d399" : networkProjectedRatio >= 0.9 ? "#fbbf24" : "#f87171" },
                  ].map((item) => (<div key={item.label} style={{ background: "rgba(21,16,21,0.72)", border: "1px solid #3b2932", borderRadius: 11, padding: "11px 13px" }}><div style={{ color: "#ae9aa5", fontSize: 9, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 4 }}>{item.label}</div><div style={{ color: item.color, fontSize: 20, fontWeight: 900 }}>{item.value}</div><div style={{ color: "#c3a7b2", fontSize: 10, lineHeight: 1.45, marginTop: 3 }}>{item.sub}</div></div>))}
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(235px, 1fr))", gap: 9 }}>
                  {[
                    { label: "Current global leader", value: bestRankedClub ? `${bestRankedClub.clubName} · #${bestRankedClub.currentMonthlyRank}` : "No global rank available", detail: bestRankedClub ? `${bestRankedClub.rankDelta > 0 ? `Gained ${bestRankedClub.rankDelta} places` : bestRankedClub.rankDelta < 0 ? `Lost ${Math.abs(bestRankedClub.rankDelta)} places` : "No rank change today"}.` : "Rank history has not loaded.", color: "#fbbf24" },
                    { label: "Strongest quota outlook", value: strongestOutlookClub ? `${strongestOutlookClub.clubName} · ${Math.round(strongestOutlookClub.projectedRatio * 100)}%` : "No reliable forecast", detail: strongestOutlookClub ? `${fmt(strongestOutlookClub.totalProjected)} projected against a ${fmt(strongestOutlookClub.clubTarget)} club quota.` : "Wait for sufficient current-club history.", color: "#f4a4b1" },
                    { label: "Biggest positive rank move", value: strongestRankMover ? `${strongestRankMover.clubName} · +${strongestRankMover.rankDelta}` : "No upward move today", detail: strongestRankMover ? `A positive number means ${strongestRankMover.rankDelta} global places gained since the prior displayed day.` : "No club gained a global position in the latest comparison.", color: "#34d399" },
                    { label: "Needs the closest look", value: weakestOutlookClub ? `${weakestOutlookClub.clubName} · ${Math.round(weakestOutlookClub.projectedRatio * 100)}%` : "No reliable forecast", detail: weakestOutlookClub ? `${clubsAtRisk.length} forecast-ready club${clubsAtRisk.length === 1 ? " is" : "s are"} below 90% of quota.${largestRankDrop ? ` ${largestRankDrop.clubName} also lost ${Math.abs(largestRankDrop.rankDelta)} rank places.` : ""}` : "Partial-data clubs are not labeled at risk.", color: clubsAtRisk.length ? "#f87171" : "#60a5fa" },
                  ].map((item) => (<div key={item.label} style={{ background: "#151115", border: `1px solid ${item.color}33`, borderRadius: 11, padding: "11px 13px" }}><div style={{ color: item.color, fontSize: 9, fontWeight: 900, textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 4 }}>{item.label}</div><div style={{ color: "#f3e9ee", fontSize: 13, fontWeight: 900, marginBottom: 3 }}>{item.value}</div><div style={{ color: "#c3a7b2", fontSize: 10, lineHeight: 1.5 }}>{item.detail}</div></div>))}
                </div>
                {partialHistoryClubs.length > 0 && (<div style={{ marginTop: 12, color: "#9ca3af", fontSize: 10, lineHeight: 1.55 }}><b style={{ color: "#d1d5db" }}>Data-quality note:</b> {partialHistoryClubs.map((entry) => entry.clubName).join(", ")} {partialHistoryClubs.length === 1 ? "is" : "are"} still visible in rank history, but excluded from pace forecasts and risk labels until at least 70% of the current roster has near-full-month history in that club.</div>)}
              </div>
              <div id="network-pace-chart" style={S.card}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 8 }}><div><div style={S.h2}>Network Pace — Progress Toward Each Club’s Quota</div><div style={{ color: "#c3a7b2", fontSize: 12, marginTop: 4, lineHeight: 1.55 }}>In Cumulative view, a club above the dashed line is ahead of the ideal elapsed-month pace. Daily Gain shows which clubs accelerated or slowed on a specific day. Hover any day for exact values.</div></div><div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}><button style={S.btn(networkChartMode === "cumulative", networkChartMode === "cumulative" ? "#a93f56" : undefined)} onClick={() => setNetworkChartMode("cumulative")}>Cumulative</button><button style={S.btn(networkChartMode === "daily", networkChartMode === "daily" ? "#a93f56" : undefined)} onClick={() => setNetworkChartMode("daily")}>Daily Gain</button></div></div>
                {strongestOutlookClub && (<div style={{ background: "rgba(169,63,86,0.10)", border: "1px solid #a93f5633", borderRadius: 9, padding: "8px 10px", color: "#ddc9d3", fontSize: 10, lineHeight: 1.5, marginBottom: 8 }}><b style={{ color: "#ffd0d8" }}>At a glance:</b> {strongestOutlookClub.clubName} has the strongest forecast at {Math.round(strongestOutlookClub.projectedRatio * 100)}% of quota{weakestOutlookClub && weakestOutlookClub.id !== strongestOutlookClub.id ? `; ${weakestOutlookClub.clubName} has the lowest forecast-ready outlook at ${Math.round(weakestOutlookClub.projectedRatio * 100)}%.` : "."}</div>)}
                {forecastReadyClubs.length ? <NetworkPaceChart clubs={forecastReadyClubs} dim={dim} today={today} mode={networkChartMode} currentDayIdx={Math.max(0, today - 1)} /> : <div style={{ color: "#ae9aa5", fontSize: 12, padding: "24px 8px", textAlign: "center" }}>No club currently has enough current-roster history for a reliable pace comparison.</div>}
              </div>
              <div id="official-fan-thresholds" style={S.card}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap", marginBottom: 10 }}>
                  <div>
                    <div style={S.h2}>Official Fan Thresholds</div>
                    <div style={{ color: "#c3a7b2", fontSize: 12, marginTop: 4, lineHeight: 1.55, maxWidth: 780 }}>The actual cutoff is supplied by UMA and shows the minimum club fans currently needed for each global tier. The modeled month-end cutoff appears only after three valid current-month observations.</div>
                  </div>
                  <div style={{ background: rankThresholdForecast.ready ? "#34d39918" : "#fbbf2418", border: "1px solid " + (rankThresholdForecast.ready ? "#34d39944" : "#fbbf2444"), borderRadius: 999, padding: "7px 10px", color: rankThresholdForecast.ready ? "#34d399" : "#fbbf24", fontSize: 10, fontWeight: 800 }}>
                    {rankThresholdForecast.ready ? "Forecast active" : rankThresholdForecast.status === "collecting" ? "Collecting observations" : "Forecast withheld"}
                  </div>
                </div>
                <div style={{ background: rankThresholdForecast.ready ? "rgba(6,78,59,0.15)" : "rgba(120,53,15,0.15)", border: "1px solid " + (rankThresholdForecast.ready ? "#34d39933" : "#f59e0b33"), borderRadius: 10, padding: "9px 11px", color: "#d5d2e5", fontSize: 10, lineHeight: 1.55, marginBottom: 12 }}>
                  <b style={{ color: rankThresholdForecast.ready ? "#34d399" : "#fbbf24" }}>Status:</b> {rankThresholdForecast.message}
                  {rankThresholdForecast.asOfDate ? <span style={{ color: "#c3a7b2" }}> Thresholds aligned through {rankThresholdForecast.asOfDate}.</span> : null}
                </div>
                {rankThresholdForecast.rows.length ? (
                  <div style={{ overflowX: "auto" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 820 }}>
                      <thead><tr style={{ textAlign: "left" }}><th style={S.th}>Official Tier</th><th style={S.th}>Placement Band</th><th style={S.th}>Actual Current Cutoff</th><th style={S.th}>Change Today</th><th style={S.th}>Vs Last Month</th><th style={S.th}>Modeled Month-End Cutoff</th></tr></thead>
                      <tbody>
                        {rankThresholdForecast.rows.filter((row) => row.current_min_fans != null).map((row) => {
                          const dailyColor = row.daily_fans_delta > 0 ? "#fbbf24" : row.daily_fans_delta < 0 ? "#34d399" : "#9ca3af";
                          const monthColor = row.current_vs_last_month_delta > 0 ? "#fbbf24" : row.current_vs_last_month_delta < 0 ? "#34d399" : "#9ca3af";
                          const placement = row.ranking_from == null ? "—" : row.ranking_to == null ? row.ranking_from.toLocaleString() + "+" : row.ranking_from.toLocaleString() + "–" + row.ranking_to.toLocaleString();
                          return (
                            <tr key={"official-threshold-" + row.rank_index}>
                              <td style={S.td}><div style={{ display: "flex", alignItems: "center", gap: 8 }}><TierIcon tier={row.name} size={20} rankingConfig={viewRankingConfig} rankIconPath={viewRankIconPath} /><span style={{ color: "#f3e9ee", fontWeight: 900 }}>{row.name}</span></div></td>
                              <td style={{ ...S.td, color: "#ddc9d3", fontWeight: 700 }}>{placement}</td>
                              <td style={{ ...S.td, color: "#f3e9ee", fontWeight: 900 }}>{fmt(row.current_min_fans)}</td>
                              <td style={{ ...S.td, color: dailyColor, fontWeight: 800 }}>{fmtSigned(row.daily_fans_delta)}</td>
                              <td style={{ ...S.td, color: monthColor, fontWeight: 800 }}>{fmtSigned(row.current_vs_last_month_delta)}</td>
                              <td style={{ ...S.td, color: row.projectedMinFans != null ? "#ffd0d8" : "#ae9aa5", fontWeight: 900 }}>{row.projectedMinFans != null ? fmt(row.projectedMinFans) : "Not available yet"}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div style={{ color: "#ae9aa5", fontSize: 12, textAlign: "center", padding: "22px 8px" }}>No threshold JSON has been loaded yet. The table will populate after the first successful workflow run.</div>
                )}
                <div style={{ color: "#ae9aa5", fontSize: 9, lineHeight: 1.55, marginTop: 10 }}>Actual Current Cutoff, Change Today, and Vs Last Month come directly from the API. Modeled Month-End Cutoff is a tracker estimate and is never presented as an official UMA result.{rankThresholdError ? " The threshold file is not available on this deployment yet." : ""}</div>
              </div>
              <window.ThresholdTrends feed={rankThresholdData} model={rankThresholdForecast} month={thresholdMonthKey} today={today} dim={dim} />
              <div id="club-rank-history" style={S.card}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
                  <div>
                    <div style={S.h2}>Global Rank History — Direction and Position</div>
                    <div style={{ color: "#c3a7b2", fontSize: 12, marginTop: 4, lineHeight: 1.55 }}>Lower rank numbers are better. Follow a club from left to right to see whether it gained or lost global positions; tier icons mark major rank boundaries.</div>
                  </div>
                </div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 }}><span style={{ background: "#34d39918", border: "1px solid #34d39944", color: "#34d399", borderRadius: 999, padding: "5px 8px", fontSize: 9, fontWeight: 800 }}>{strongestRankMover ? `${strongestRankMover.clubName}: +${strongestRankMover.rankDelta} places` : "No club gained places today"}</span><span style={{ background: "#f8717118", border: "1px solid #f8717144", color: "#f87171", borderRadius: 999, padding: "5px 8px", fontSize: 9, fontWeight: 800 }}>{largestRankDrop ? `${largestRankDrop.clubName}: ${largestRankDrop.rankDelta} places` : "No club lost places today"}</span></div>
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
                    rankThresholdData={rankThresholdData}
                    today={today}
                    dim={dim}
                    monthKey={formatDateKey(year, monthIndex + 1, 1).slice(0, 7)}
                    archiveMonth={archiveMonth}
                    isArchiveView={isArchiveView}
                  />
                : <div style={{ ...S.card, minHeight: 300, display: "flex", alignItems: "center", justifyContent: "center", color: "#f87171" }}>Deeper Insights failed to load. Refresh the page and check the browser console.</div>
            )}
          </>)}

          {view === "club" && !cid && (<div style={{ ...S.card, textAlign: "center", padding: "50px 20px" }}><div style={{ fontSize: 40, marginBottom: 10 }}>🔜</div><div style={{ color: "#ae9aa5" }}><b style={{ color: "#9ca3af" }}>{club.name}</b> is a future addition.</div></div>)}

          {view === "club" && cid && (<>
            <div className="club-banner" style={{ ...S.card, background: tc.bg, border: `1px solid ${tc.border}`, padding: "14px 18px", "--tier-c": tc.border }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8, position: "relative" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <span className="gate-plate">{String(activeIdx + 1).padStart(2, "0")}</span>
                  <TierBadge tier={club.tier} rankingConfig={viewRankingConfig} rankIconPath={viewRankIconPath} />
                  <div>
                    <div style={{ fontSize: 20, fontWeight: 800, color: "#f3e9ee", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                      {clubName}
                      {(() => { const ri = getClubRankInfo(cid); return ri.rank != null ? <MonthlyRankBadge rank={ri.rank} delta={ri.delta} rankingConfig={viewRankingConfig} rankIconPath={viewRankIconPath} /> : null; })()}
                    </div>
                    <div style={{ fontSize: 11, color: "#9ca3af" }}>Officer: {club.officer} · ID: {club.id || "TBD"} · Max {viewMaxMembers} members</div>
                  </div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: tc.text }}>{fmt(club.target)} / member / month</div>
                  <div style={{ fontSize: 10, color: "#ae9aa5", marginTop: 2 }}>Week {currentWeek?.number || 1} · {getWeekLabel(currentWeek, year, monthIndex)}</div>
                  {displayFetch && <div style={{ fontSize: 10, color: "#ae9aa5", marginTop: 2 }}>{displayFetchLabel} {new Date(displayFetch).toLocaleString()}</div>}
                </div>
              </div>
            </div>

            {!decoratedMembers.length ? (<div style={{ ...S.card, textAlign: "center", padding: "50px 20px" }}><div style={{ fontSize: 44, marginBottom: 10 }}>🏇</div><div style={{ color: "#ae9aa5", marginBottom: 16 }}>No active member data for <b style={{ color: "#9ca3af" }}>{clubName}</b> yet.</div><div style={{ display: "flex", justifyContent: "center", gap: 8 }}><button style={S.btn(false, tc.bar)} onClick={() => fetchData()}>🔄 Refresh Data</button></div></div>) : (<>
              <div className="tab-dock">
                {[["dashboard", "📊 Overview"], ["members", "👥 Members"], ["pace", "📈 Pace"]].map(([tabKey, label]) => (<button key={tabKey} style={S.btn(tab === tabKey, tab === tabKey ? tc.bar : undefined)} onClick={() => setTab(tabKey)}>{label}</button>))}
              </div>

              {tab === "dashboard" && (<>
                <div style={{ ...S.card, background: `${clubOutlookColor}0d`, border: `1px solid ${clubOutlookColor}44` }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start", flexWrap: "wrap", marginBottom: 12 }}><div><div style={S.h2}>Club Pulse</div><div style={{ color: "#f3e9ee", fontSize: 18, fontWeight: 900 }}>{clubOutlookLabel}</div><div style={{ color: "#c3a7b2", fontSize: 11, marginTop: 4 }}>{fmt(totalProj)} projected against a {fmt(clubMonthlyTarget)} full-club quota.</div></div><div style={{ background: `${clubOutlookColor}18`, border: `1px solid ${clubOutlookColor}55`, color: clubOutlookColor, borderRadius: 999, padding: "6px 9px", fontSize: 10, fontWeight: 900 }}>{Math.round(clubProjectedRatio * 100)}% projected</div></div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))", gap: 9 }}>
                    {[
                      { label: "Goal progress", value: `${Math.round(clubGoalProgressRatio * 100)}%`, sub: `${fmt(totalMonthly)} earned so far`, color: clubGoalProgressRatio >= today / dim ? "#34d399" : "#fbbf24" },
                      { label: "Members on pace", value: `${statusCounts["on-track"]}/${decoratedMembers.length}`, sub: `${statusCounts["behind"] + statusCounts["critical"]} currently need attention`, color: "#34d399" },
                      { label: "Largest contributor", value: clubTopContributor?.name || "—", sub: clubTopContributor ? `${fmt(clubTopContributor.monthlyGain)} this month` : "No member data", color: "#ffd0d8" },
                      { label: "First review", value: clubLargestPlanGap?.name || "—", sub: clubLargestPlanGap ? `${fmtSigned(clubLargestPlanGap.plan.delta)} versus elapsed plan` : "No plan gap", color: clubLargestPlanGap && (clubLargestPlanGap.plan.delta ?? 0) < 0 ? "#f87171" : "#60a5fa" },
                    ].map((item) => <div key={item.label} style={{ background: "rgba(21,16,21,0.68)", border: "1px solid #3b2932", borderRadius: 10, padding: "10px 12px" }}><div style={{ color: "#ae9aa5", fontSize: 9, textTransform: "uppercase", letterSpacing: "0.08em" }}>{item.label}</div><div style={{ color: item.color, fontSize: 15, fontWeight: 900, marginTop: 4 }}>{item.value}</div><div style={{ color: "#c3a7b2", fontSize: 9, marginTop: 3 }}>{item.sub}</div></div>)}
                  </div>
                  <div style={{ color: "#ddc9d3", fontSize: 10, lineHeight: 1.55, marginTop: 11 }}><b style={{ color: clubOutlookColor }}>What to do:</b> {clubProjectedRatio >= 1 ? "Protect the current pace and focus officer attention on the members furthest below elapsed plan." : `The club is projected ${fmt(Math.max(0, clubMonthlyTarget - totalProj))} short. Start with ${clubLargestPlanGap?.name || "the largest negative plan gaps"} and confirm whether the slowdown is temporary.`}</div>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 10, marginBottom: 14 }}>
                  {[
                    { label: "Active Members", value: hasComparisonData ? `${decoratedMembers.length}/${viewMaxMembers}` : "—", sub: hasComparisonData ? "Inactive excluded" : noComparisonLabel, col: hasComparisonData ? "#f3e9ee" : "#9ca3af" },
                    { label: `${STATUS_META["on-track"].icon} ${STATUS_META["on-track"].label}`, value: hasComparisonData ? statusCounts["on-track"] : "—", sub: hasComparisonData ? "At or above weekly pace" : noComparisonLabel, col: "#34d399", filterKey: hasComparisonData ? "on-track" : null },
                    { label: `${STATUS_META["behind"].icon} ${STATUS_META["behind"].label}`, value: hasComparisonData ? statusCounts["behind"] : "—", sub: hasComparisonData ? "Below pace but above 25%" : noComparisonLabel, col: "#fbbf24", filterKey: hasComparisonData ? "behind" : null },
                    { label: `${STATUS_META["critical"].icon} ${STATUS_META["critical"].label}`, value: hasComparisonData ? statusCounts["critical"] : "—", sub: hasComparisonData ? "Under 25% of weekly pace" : noComparisonLabel, col: "#f87171", filterKey: hasComparisonData ? "critical" : null },
                    { label: "Club Monthly +", value: hasComparisonData ? fmt(totalMonthly) : "—", sub: hasComparisonData ? "All active members" : noComparisonLabel, col: hasComparisonData ? gainColor(totalMonthly) : "#9ca3af" },
                    { label: "Club Daily +", value: totalDaily != null ? fmt(totalDaily) : "—", sub: `Current Day ${today} total fan gain`, col: "#e6cfd8" },
                    { label: "Previous Day +", value: totalPreviousDaily != null ? fmt(totalPreviousDaily) : "—", sub: today > 1 ? `Day ${today - 1} total fan gain` : "No previous day in this month", col: "#ffd0d8" },
                    { label: "Club Vs Weekly Plan", value: hasComparisonData ? fmtSigned(clubWeeklyDelta) : "—", sub: hasComparisonData ? `Target by displayed day: ${fmt(clubExpectedToDate)}` : noComparisonLabel, col: hasComparisonData ? gainColor(clubWeeklyDelta) : "#9ca3af" },
                  ].map((card) => { const isFilterCard = Boolean(card.filterKey); const isActive = overviewStatusFilter === card.filterKey; const sharedStyle = { background: "#1d171c", border: `1px solid ${isActive ? card.col : "#3b2932"}`, borderRadius: 12, padding: "11px 14px", boxShadow: isActive ? `0 0 0 1px ${card.col}33 inset` : "none" }; return isFilterCard ? (<button key={card.label} onClick={() => toggleOverviewStatusFilter(card.filterKey)} style={{ ...sharedStyle, textAlign: "left", cursor: "pointer" }}><div style={{ color: "#a18c98", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 3 }}>{card.label}</div><div style={{ color: card.col, fontSize: 18, fontWeight: 700 }}>{card.value}</div><div style={{ color: isActive ? card.col : "#a18c98", fontSize: 10, marginTop: 2 }}>{isActive ? "Showing only this status" : card.sub}</div></button>) : (<div key={card.label} style={sharedStyle}><div style={{ color: "#a18c98", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 3 }}>{card.label}</div><div style={{ color: card.col, fontSize: 18, fontWeight: 700 }}>{card.value}</div><div style={{ color: "#a18c98", fontSize: 10, marginTop: 2 }}>{card.sub}</div></div>); })}
                </div>

                <window.ClubBoundaryChart feed={rankThresholdData} data={clubData[cid]} club={club} month={thresholdMonthKey} today={today} dim={dim} />
                <div style={S.card}>
                  <div style={S.h2}>Member Progress — Sorted by Monthly Gain</div>
                  {overviewStatusFilter && (<div style={{ color: STATUS_META[overviewStatusFilter]?.color || "#9ca3af", fontSize: 12, marginBottom: 10 }}>Filtering overview to {STATUS_META[overviewStatusFilter]?.icon} {STATUS_META[overviewStatusFilter]?.label}. Click the same summary card again to clear.</div>)}
                  {!hasComparisonData && (<div style={{ color: "#ae9aa5", fontSize: 12, marginBottom: 10 }}>{noComparisonLabel}</div>)}
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {overviewMembers.length === 0 && (<div style={{ background: "rgba(21,16,21,0.72)", border: "1px solid #3b2932", borderRadius: 10, padding: "14px 16px", color: "#ae9aa5", fontSize: 12 }}>No members match the current overview filter.</div>)}
                    {overviewMembers.map((member, index) => { const monthPct = club.target > 0 ? Math.min(100, ((member.monthlyGain ?? 0) / club.target) * 100) : 0; const stillNeed = Math.max(0, club.target - (member.monthlyGain ?? 0)); const statusMeta = getDisplayStatusMeta(member.plan.statusKey); const progressColor = statusMeta.color; return (
                      <div key={`${member.name}-${index}`} style={{ background: "rgba(21,16,21,0.72)", border: "1px solid #3b2932", borderRadius: 10, padding: "12px 14px" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 7, flexWrap: "wrap", gap: 4 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 8 }}><span style={{ color: "#a18c98", fontSize: 11, fontWeight: 700, minWidth: 20 }}>#{index + 1}</span><span style={{ fontWeight: 700, color: "#f3e9ee", fontSize: 13 }}>{member.name}</span><StatusBadge statusKey={getDisplayStatusKey(member.plan.statusKey)} /><StagnantBadge days={member.stagnantDays} /></div>
                          <div style={{ display: "flex", gap: 14, fontSize: 11, flexWrap: "wrap" }}><span style={{ color: "#ae9aa5" }}>Today: <b style={{ color: gainColor(member.dailyGain) }}>{member.dailyGain != null ? fmtSigned(member.dailyGain) : "—"}</b></span><span style={{ color: "#ae9aa5" }}>Month: <b style={{ color: gainColor(member.monthlyGain) }}>{member.monthlyGain != null ? fmtSigned(member.monthlyGain) : "—"}</b></span><span style={{ color: "#ae9aa5" }}>Projected: <b style={{ color: "#ffd0d8" }}>{member.projected != null ? fmt(member.projected) : "—"}</b></span><span style={{ color: "#ae9aa5" }}>ETA: <b><DaysToTargetBadge days={member.daysToTarget} daysLeft={daysLeft} /></b></span></div>
                        </div>
                        <div style={{ marginBottom: 8 }}><ProgressBar pct={monthPct} color={progressColor} height={9} /></div>
                        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 10, alignItems: "center" }}>
                          <div><div style={{ color: "#a18c98", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em" }}>Current Fans</div><div style={{ color: "#f3e9ee", fontWeight: 700, fontSize: 14 }}>{fmtFull(member.fans)}</div></div>
                          <div><div style={{ color: "#a18c98", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em" }}>Target Progress</div><div style={{ color: progressColor, fontWeight: 700, fontSize: 14 }}>{monthPct.toFixed(1)}%</div></div>
                          <div><div style={{ color: "#a18c98", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em" }}>Still Needed</div><div style={{ color: "#f3e9ee", fontWeight: 700, fontSize: 14 }}>{fmt(stillNeed)}</div></div>
                          <div><div style={{ color: "#a18c98", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em" }}>Vs Weekly Plan</div><div style={{ color: progressColor, fontWeight: 700, fontSize: 14 }}>{displayPlanDeltaText(member.plan.delta)}</div></div>
                          <div style={{ justifySelf: "end" }}><Sparkline data={member.cumulativeSeries || member.dailyFans || []} visibleDayCount={today} color={statusMeta.color} /></div>
                        </div>
                      </div>
                    ); })}
                  </div>
                </div>
              </>)}

              {tab === "members" && (
                <div style={S.card}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 10 }}><div><div style={S.h2}>Members</div><div style={{ color: "#ae9aa5", fontSize: 12 }}>Name and Status use dropdown filters. Fans, Today, Month, and Projected cycle through Desc, Asc, and Off sorting.</div></div><button style={S.btn(false)} onClick={clearMemberFilters}>Clear filters</button></div>
                  <div style={{ overflowX: "auto" }}><table style={{ width: "100%", borderCollapse: "collapse" }}><thead><tr style={{ textAlign: "left" }}>
                    {[{ key: "rank", label: "#", sortable: false }, { key: "name", label: "Name", sortable: false }, { key: "fans", label: "Fans", sortable: true }, { key: "dailyGain", label: "Today", sortable: true }, { key: "monthlyGain", label: "Month", sortable: true }, { key: "projected", label: "Projected", sortable: true }, { key: "weeklyDelta", label: "Vs Weekly Plan", sortable: false }, { key: "daysToTarget", label: "ETA", sortable: true }, { key: "stagnantDays", label: "Idle", sortable: true }, { key: "status", label: "Status", sortable: false }].map((col) => (<th key={col.key} style={S.th}>{col.sortable ? (<button style={{ background: "transparent", border: "none", color: "inherit", font: "inherit", cursor: "pointer", padding: 0, display: "inline-flex", gap: 6, alignItems: "center" }} onClick={() => handleSort(col.key)}><span>{col.label}</span><span style={{ color: memberSort.key === col.key ? tc.text : "#a18c98", fontSize: 10 }}>{sortIndicator(col.key)}</span></button>) : (<span>{col.label}</span>)}</th>))}
                  </tr><tr><th style={S.th}></th><th style={S.th}><select style={S.input} value={memberFilters.name} onChange={(e) => updateMemberFilter("name", e.target.value)}><option value="">All Members</option>{memberNameOptions.map((name) => (<option key={name} value={name}>{name}</option>))}</select></th><th style={S.th}></th><th style={S.th}></th><th style={S.th}></th><th style={S.th}></th><th style={S.th}></th><th style={S.th}></th><th style={S.th}></th><th style={S.th}><select style={S.input} value={memberFilters.status} onChange={(e) => updateMemberFilter("status", e.target.value)}><option value="">All Statuses</option>{hasComparisonData ? (<><option value="on-track">On Track</option><option value="behind">Behind</option><option value="critical">Critical</option></>) : (<option value={DAY1_STATUS_KEY}>N/A - Day 1</option>)}</select></th></tr></thead><tbody>
                    {memberRows.length === 0 ? (<tr><td colSpan={10} style={{ ...S.td, color: "#ae9aa5", textAlign: "center", padding: "22px 8px" }}>No members match the current filters.</td></tr>) : (
                      memberRows.map(({ member, rank }) => (<tr key={`${member.name}-${rank}`}><td style={{ ...S.td, color: "#ae9aa5" }}>{rank}</td><td style={{ ...S.td, color: "#f3e9ee", fontWeight: 700 }}>{member.name}</td><td style={S.td}>{fmtFull(member.fans)}</td><td style={{ ...S.td, color: gainColor(member.dailyGain) }}>{member.dailyGain != null ? fmtSigned(member.dailyGain) : "—"}</td><td style={{ ...S.td, color: gainColor(member.monthlyGain) }}>{member.monthlyGain != null ? fmtSigned(member.monthlyGain) : "—"}</td><td style={{ ...S.td, color: "#ffd0d8" }}>{member.projected != null ? fmt(member.projected) : "—"}</td><td style={{ ...S.td, color: hasComparisonData ? (STATUS_META[member.plan.statusKey]?.color || gainColor(member.plan.delta)) : "#9ca3af", fontWeight: 700 }}>{displayPlanDeltaText(member.plan.delta)}</td><td style={S.td}><DaysToTargetBadge days={member.daysToTarget} daysLeft={daysLeft} /></td><td style={S.td}><StagnantBadge days={member.stagnantDays} /></td><td style={S.td}><StatusBadge statusKey={getDisplayStatusKey(member.plan.statusKey)} /></td></tr>))
                    )}
                  </tbody></table></div>
                </div>
              )}

              {tab === "pace" && (
                <div style={S.card}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}><div><div style={S.h2}>Member Pace</div><div style={{ color: "#ae9aa5", fontSize: 12 }}>Toggle between cumulative progress and daily gain. The chart only draws through the displayed data day, and inactive members are fully excluded.</div></div><div style={{ color: "#9ca3af", fontSize: 12 }}>{getWeekLabel(currentWeek, year, monthIndex)}</div></div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 10, marginBottom: 14 }}>
                    {[{ label: "Current Week", value: `Week ${currentWeek?.number || 1}`, sub: getWeekLabel(currentWeek, year, monthIndex), col: "#f3e9ee" }, { label: "Per-Member Target by Displayed Day", value: hasComparisonData ? fmt(decoratedMembers[0]?.plan.expectedToDate ?? 0) : "—", sub: hasComparisonData ? `${fmt(club.target)} monthly quota` : noComparisonLabel, col: hasComparisonData ? "#ffd0d8" : "#9ca3af" }, { label: "Current Week Target", value: fmt(decoratedMembers[0]?.plan.currentWeekTarget ?? 0), sub: getWeekLabel(currentWeek, year, monthIndex), col: "#34d399" }, { label: "Visible on Graph", value: `${paceSeriesList.length}/${allPaceSeriesList.length}`, sub: hasComparisonData ? `${statusCounts["on-track"]} on track · ${statusCounts["critical"]} critical` : noComparisonLabel, col: "#f3e9ee" }].map((card) => (<div key={card.label} style={{ background: "rgba(21,16,21,0.72)", border: "1px solid #3b2932", borderRadius: 12, padding: "11px 14px" }}><div style={{ color: "#a18c98", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 3 }}>{card.label}</div><div style={{ color: card.col, fontSize: 18, fontWeight: 700 }}>{card.value}</div><div style={{ color: "#a18c98", fontSize: 10, marginTop: 2 }}>{card.sub}</div></div>))}
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 10 }}>
                    <div style={{ color: "#9ca3af", fontSize: 12 }}>Click on the graph to pin a tooltip, then export to include it in the image.{" "}{pacePinnedIdx != null && (<span style={{ color: "#f4a4b1", fontWeight: 700 }}>📌 Tooltip pinned — export will capture it.</span>)}</div>
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}><button style={S.btn(paceChartMode === "cumulative", "#a93f56")} onClick={() => setPaceChartMode("cumulative")}>Cumulative</button><button style={S.btn(paceChartMode === "daily", "#2563eb")} onClick={() => setPaceChartMode("daily")}>Daily Gain</button><button style={S.btn(false)} onClick={() => setPaceZoom((prev) => Math.max(1, +(prev - 0.25).toFixed(2)))}>− Zoom</button><button style={S.btn(false)} onClick={() => setPaceZoom(1)}>Reset</button><button style={S.btn(false)} onClick={() => setPaceZoom((prev) => Math.min(3, +(prev + 0.25).toFixed(2)))}>+ Zoom</button>{pacePinnedIdx != null && (<button style={S.btn(false, "#f4a4b1")} onClick={() => setPacePinnedIdx(null)}>📌 Unpin Tooltip</button>)}<button style={S.btn(false)} onClick={exportPaceGraph}>{paceExporting ? "⟳ Exporting…" : "🖼️ Export Graph"}</button></div>
                  </div>
{supportsMemberDailyFans ? <PaceChart seriesList={paceSeriesList} targetSeries={selectedPaceTargetSeries} weeks={monthWeeks} year={year} monthIndex={monthIndex} svgRef={paceSvgRef} zoom={paceZoom} pinnedIdx={pacePinnedIdx} setPinnedIdx={setPacePinnedIdx} containerRef={paceContainerRef} currentDayIdx={Math.max(0, today - 1)} mode={paceChartMode} /> : <div style={{ color: "#ae9aa5", fontSize: 12, padding: "18px 0" }}>This source does not expose enough per-member daily history to render the pace chart.</div>}
                  <div style={{ marginTop: 16, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 10 }}>
                    {monthWeeks.map((week) => { const isFutureWeek = week.startDay > today; const measuredEndDay = Math.min(week.endDay, today); const elapsedDayCount = Math.max(0, measuredEndDay - week.startDay + 1); const fullWeekTarget = Math.round((club.target / Math.max(dim, 1)) * week.dayCount); const elapsedWeekTarget = Math.round((club.target / Math.max(dim, 1)) * elapsedDayCount); const checkpointTarget = week.endDay <= today ? fullWeekTarget : elapsedWeekTarget; const currentValues = isFutureWeek ? [] : allPaceSeriesList.map((item) => (item.dailySeries || []).slice(Math.max(0, week.startDay - 1), Math.max(0, measuredEndDay)).reduce((sum, value) => sum + (value || 0), 0)).sort((a, b) => b - a); const medianValue = currentValues.length ? currentValues[Math.floor(currentValues.length / 2)] : null; const medianDelta = medianValue == null ? null : medianValue - checkpointTarget; const onPaceAtCheckpoint = currentValues.filter((value) => value >= checkpointTarget).length; return (<div key={week.number} style={{ background: "rgba(21,16,21,0.72)", border: "1px solid #3b2932", borderRadius: 12, padding: "12px 13px" }}><div style={{ color: "#f3e9ee", fontWeight: 700, fontSize: 13, marginBottom: 4 }}>Week {week.number}</div><div style={{ color: "#ae9aa5", fontSize: 11, marginBottom: 8 }}>{getWeekLabel(week, year, monthIndex)}</div><div style={{ color: "#ae9aa5", fontSize: 11 }}>Per-member weekly target: <b style={{ color: "#ffd0d8" }}>{fmt(week.endDay <= today ? fullWeekTarget : checkpointTarget)}</b></div>{!isFutureWeek && (<div style={{ color: "#ae9aa5", fontSize: 11 }}>Median member weekly actual: <b style={{ color: "#fbbf24" }}>{fmt(medianValue)}</b>{" "}<span style={{ color: gainColor(medianDelta), fontWeight: 700 }}>({fmtSigned(medianDelta)})</span></div>)}<div style={{ color: "#9ca3af", fontSize: 11, fontWeight: 700, marginTop: 5 }}>{isFutureWeek ? "Not started yet" : `${onPaceAtCheckpoint}/${allPaceSeriesList.length} on pace for the week`}</div></div>); })}
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap", alignItems: "center", marginTop: 16, marginBottom: 10 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}><div style={{ color: "#9ca3af", fontSize: 12 }}>Click cards to toggle visibility.</div><button style={S.btn(false)} onClick={() => setPaceCardsCollapsed((p) => !p)}>{paceCardsCollapsed ? "▼ Expand Cards" : "▲ Collapse Cards"}</button></div>
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}><button style={S.btn(false)} onClick={showAllPaceMembers}>Show All</button><button style={S.btn(false)} onClick={hideAllPaceMembers}>Hide All</button><button style={S.btn(false, STATUS_META["on-track"].color)} onClick={() => showOnlyPaceStatus("on-track")}>{STATUS_META["on-track"].icon} On Track Only</button><button style={S.btn(false, STATUS_META["behind"].color)} onClick={() => showOnlyPaceStatus("behind")}>{STATUS_META["behind"].icon} Behind Only</button><button style={S.btn(false, STATUS_META["critical"].color)} onClick={() => showOnlyPaceStatus("critical")}>{STATUS_META["critical"].icon} Critical Only</button></div>
                  </div>
                  {paceCardsCollapsed ? (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                      {sortedByMonthly.map((member, index) => { const isHidden = Boolean(paceHiddenMembers[member.name]); const lineColor = allPaceSeriesList.find((s) => s.name === member.name)?.color || getLineColor(index); const sm = STATUS_META[member.plan.statusKey] || STATUS_META["behind"]; return (<button key={`chip-${member.name}`} onClick={() => togglePaceMember(member.name)} style={{ background: isHidden ? "#120e12" : "#0f0d1a", border: `1px solid ${isHidden ? "#3b2932" : sm.border}`, borderRadius: 8, padding: "5px 10px", cursor: "pointer", opacity: isHidden ? 0.5 : 1, display: "flex", alignItems: "center", gap: 6, fontSize: 11 }}><span style={{ width: 8, height: 8, borderRadius: 999, background: lineColor, flexShrink: 0 }} /><span style={{ color: "#f3e9ee", fontWeight: 700 }}>{member.name}</span><span style={{ color: sm.color, fontSize: 10 }}>{fmtSigned(member.monthlyGain ?? 0)}</span>{member.stagnantDays >= 2 && <span style={{ color: "#f97316", fontSize: 9 }}>⏸{member.stagnantDays}d</span>}</button>); })}
                    </div>
                  ) : (
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: 10 }}>
                      {sortedByMonthly.map((member, index) => { const statusMeta = STATUS_META[member.plan.statusKey] || STATUS_META["behind"]; const isHidden = Boolean(paceHiddenMembers[member.name]); const lineColor = allPaceSeriesList.find((item) => item.name === member.name)?.color || getLineColor(index); return (
                        <button key={`pace-card-${member.name}`} onClick={() => togglePaceMember(member.name)} style={{ background: isHidden ? "#120e12" : "#0f0d1a", border: `1px solid ${isHidden ? "#3b2932" : statusMeta.border}`, borderRadius: 12, padding: "12px 13px", textAlign: "left", cursor: "pointer", opacity: isHidden ? 0.55 : 1, boxShadow: isHidden ? "none" : `0 0 0 1px ${statusMeta.bg} inset` }}>
                          <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center", marginBottom: 8 }}><div style={{ minWidth: 0 }}><div style={{ color: "#f3e9ee", fontWeight: 800, fontSize: 13, display: "flex", alignItems: "center", gap: 7 }}><span style={{ width: 10, height: 10, borderRadius: 999, background: lineColor, display: "inline-block", flexShrink: 0 }} /><span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{member.name}</span></div><div style={{ color: "#ae9aa5", fontSize: 11, marginTop: 3, display: "flex", alignItems: "center", gap: 6 }}>{isHidden ? "Hidden" : "Showing"} <StagnantBadge days={member.stagnantDays} /></div></div><StatusBadge statusKey={getDisplayStatusKey(member.plan.statusKey)} /></div>
                          <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 8 }}>
                            <div><div style={{ color: "#a18c98", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em" }}>Total Fans</div><div style={{ color: "#f3e9ee", fontWeight: 700, fontSize: 14 }}>{fmtFull(member.fans)}</div></div>
                            <div><div style={{ color: "#a18c98", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em" }}>Monthly Gain</div><div style={{ color: statusMeta.color, fontWeight: 700, fontSize: 14 }}>{fmtSigned(member.monthlyGain ?? 0)}</div></div>
                            <div><div style={{ color: "#a18c98", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em" }}>ETA to Target</div><div style={{ color: statusMeta.color, fontWeight: 700, fontSize: 14 }}><DaysToTargetBadge days={member.daysToTarget} daysLeft={daysLeft} /></div></div>
                            <div><div style={{ color: "#a18c98", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em" }}>Vs Weekly Plan</div><div style={{ color: statusMeta.color, fontWeight: 700, fontSize: 14 }}>{deltaText(member.plan.delta)}</div></div>
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
                  <div style={{ color: "#9ca3af", fontSize: 12, marginBottom: 12, lineHeight: 1.7 }}>This page reads JSON from your deployed repo files. Expected path for this club: <b style={{ color: "#f3e9ee" }}>`data/chronogenesis/${cid}.json`</b></div>
                  <pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", background: "#120e12", border: "1px solid #3b2932", borderRadius: 10, padding: 12, color: "#ffd0d8", fontSize: 12, lineHeight: 1.55 }}>{debugLog.length ? debugLog.join("\n") : "No debug entries yet."}</pre>
                </div>
              )}
            </>)}
          </>)}
            </main>
          </div>

          {/* ── Mobile dock ── */}
          <div className="mobile-dock">
            <a href="./index.html" style={{ ...S.btn(PAGE_MODE === "home", "#a93f56"), flex: 1, textDecoration: "none", textAlign: "center" }}>🏠 Home</a>
            <a href="./clubs.html" style={{ ...S.btn(PAGE_MODE === "clubs", "#a93f56"), flex: 1, textDecoration: "none", textAlign: "center" }}>📋 Clubs</a>
            <a href="./rankings.html" style={{ ...S.btn(PAGE_MODE === "rankings", "#2563eb"), flex: 1, textDecoration: "none", textAlign: "center" }}>🌐 Ranks</a>
            <a href={clubDetailHref} style={{ ...S.btn(PAGE_MODE === "club", tc.bar), flex: 1, textDecoration: "none", textAlign: "center" }}>🏇 Detail</a>
            <a href={insightsHref} style={{ ...S.btn(PAGE_MODE === "archives", "#f4a4b1"), flex: 1, textDecoration: "none", textAlign: "center" }}>🔎 Insights</a>
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
