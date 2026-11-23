(() => {
  "use strict";

  const DATA_PATH = "./data/network-leaderboard.json";
  const CONFIG_PATH = "./config/frontend.json";
  const AUTO_REFRESH_MS = 5 * 60 * 1000;
  const RANK_TIERS = [
    { name: "SS", max: 10, icon: 11 },
    { name: "S+", max: 30, icon: 10 },
    { name: "S", max: 100, icon: 9 },
    { name: "A+", max: 500, icon: 8 },
    { name: "A", max: 1000, icon: 7 },
    { name: "B+", max: 3000, icon: 6 },
    { name: "B", max: 5000, icon: 5 },
    { name: "C+", max: 7000, icon: 4 },
    { name: "C", max: 10000, icon: 3 },
    { name: "D+", max: Number.POSITIVE_INFINITY, icon: 2 },
  ];

  const els = {
    refresh: document.getElementById("refresh-button"),
    status: document.getElementById("snapshot-status"),
    summary: document.getElementById("summary-cards"),
    podium: document.getElementById("podium"),
    body: document.getElementById("leaderboard-body"),
    updated: document.getElementById("last-updated"),
    countdown: document.getElementById("next-refresh"),
  };

  let nextRefreshAt = Date.now() + AUTO_REFRESH_MS;
  let loading = false;

  function finiteNumber(value) {
    if (value === null || value === undefined || value === "") return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function tierForRank(rank) {
    const number = finiteNumber(rank);
    return number == null ? { name: "—", icon: 1 } : RANK_TIERS.find((tier) => number <= tier.max) || RANK_TIERS.at(-1);
  }

  function rankIcon(rank) {
    const tier = tierForRank(rank);
    return `./data/rank_pics/utx_ico_circle_rank_${String(tier.icon).padStart(2, "0")}.png`;
  }

  function formatRank(value) {
    const number = finiteNumber(value);
    return number == null ? "—" : `#${number.toLocaleString("en-US")}`;
  }

  function formatPoints(value) {
    const number = finiteNumber(value);
    if (number == null) return "—";
    const absolute = Math.abs(number);
    if (absolute >= 1_000_000_000) return `${(number / 1_000_000_000).toFixed(2)}B`;
    if (absolute >= 1_000_000) return `${(number / 1_000_000).toFixed(2)}M`;
    if (absolute >= 1_000) return `${(number / 1_000).toFixed(1)}K`;
    return number.toLocaleString("en-US");
  }

  function safeDate(value) {
    if (!value) return null;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  function relativeTime(value) {
    const date = safeDate(value);
    if (!date) return "Unknown";
    const seconds = Math.round((date.getTime() - Date.now()) / 1000);
    const absolute = Math.abs(seconds);
    if (absolute < 45) return "just now";
    if (absolute < 90) return seconds < 0 ? "1 minute ago" : "in 1 minute";
    const minutes = Math.round(seconds / 60);
    if (Math.abs(minutes) < 60) return new Intl.RelativeTimeFormat("en", { numeric: "auto" }).format(minutes, "minute");
    const hours = Math.round(minutes / 60);
    if (Math.abs(hours) < 48) return new Intl.RelativeTimeFormat("en", { numeric: "auto" }).format(hours, "hour");
    const days = Math.round(hours / 24);
    return new Intl.RelativeTimeFormat("en", { numeric: "auto" }).format(days, "day");
  }

  function exactTime(value) {
    const date = safeDate(value);
    return date ? date.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "Unknown";
  }

  function latestDay(dataset) {
    return (Array.isArray(dataset?.club_daily_history) ? dataset.club_daily_history : [])
      .filter((row) => finiteNumber(row?.rank) != null && finiteNumber(row?.actual_date) != null)
      .sort((a, b) => Number(b.actual_date) - Number(a.actual_date))[0] || null;
  }

  async function fetchJson(url) {
    const separator = url.includes("?") ? "&" : "?";
    const response = await fetch(`${url}${separator}_=${Date.now()}`, { cache: "no-store", headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    return response.json();
  }

  async function buildFallbackSnapshot() {
    const config = await fetchJson(CONFIG_PATH);
    const clubs = Array.isArray(config?.clubs) ? config.clubs : [];
    const rows = await Promise.all(clubs.map(async (club) => {
      try {
        const dataset = await fetchJson(`./data/chronogenesis/${club.id}.json`);
        const clubRecord = Array.isArray(dataset?.club) ? dataset.club[0] : dataset?.club;
        const day = latestDay(dataset);
        const globalRank = finiteNumber(day?.rank) ?? finiteNumber(clubRecord?.rank);
        return {
          id: String(club.id), name: clubRecord?.name || club.name, configuredName: club.name,
          networkTier: club.tier, officer: club.officer || "", globalRank,
          officialTier: tierForRank(globalRank).name, dailyRankChange: finiteNumber(day?.rank_gain),
          rankChange: finiteNumber(day?.rank_gain), points: finiteNumber(day?.interpolated_fan_count),
          memberCount: finiteNumber(clubRecord?.member_num), apiLastUpdated: clubRecord?.updated_at || null,
          fetchedAt: clubRecord?.updated_at || null, rankSource: "chronogenesis-fallback", fresh: false,
          staleReason: "The scheduled uma.moe snapshot is not available yet.",
        };
      } catch (error) {
        return {
          id: String(club.id), name: club.name, configuredName: club.name, networkTier: club.tier,
          officer: club.officer || "", globalRank: null, officialTier: null, dailyRankChange: null,
          rankChange: null, points: null, memberCount: null, apiLastUpdated: null, fetchedAt: null,
          rankSource: null, fresh: false, staleReason: error.message,
        };
      }
    }));
    rows.sort((a, b) => (finiteNumber(a.globalRank) ?? Infinity) - (finiteNumber(b.globalRank) ?? Infinity));
    rows.forEach((row, index) => { row.networkPosition = index + 1; });
    const dates = rows.map((row) => safeDate(row.apiLastUpdated)).filter(Boolean).sort((a, b) => a - b);
    return {
      schemaVersion: 1,
      source: "Chronogenesis browser fallback",
      updatedAt: dates.at(-1)?.toISOString() || null,
      sourceUpdatedAt: dates.at(-1)?.toISOString() || null,
      expectedRefreshMinutes: 60,
      complete: false,
      bootstrap: true,
      freshCount: 0,
      staleCount: rows.length,
      clubs: rows,
    };
  }

  function movementMarkup(row) {
    const daily = finiteNumber(row.dailyRankChange);
    const refresh = finiteNumber(row.rankChange);
    const change = daily ?? refresh;
    const basis = daily != null ? "vs yesterday" : "vs last sync";
    if (change == null) return '<span class="lb-movement flat">—<span class="lb-movement-sub">Not available</span></span>';
    if (change > 0) return `<span class="lb-movement up">▲ ${change.toLocaleString("en-US")}<span class="lb-movement-sub">${basis}</span></span>`;
    if (change < 0) return `<span class="lb-movement down">▼ ${Math.abs(change).toLocaleString("en-US")}<span class="lb-movement-sub">${basis}</span></span>`;
    return `<span class="lb-movement flat">— No change<span class="lb-movement-sub">${basis}</span></span>`;
  }

  function summaryCard(label, value, sub, color) {
    return `<article class="lb-stat" style="--stat-color:${color}">
      <div class="lb-stat-label">${escapeHtml(label)}</div>
      <div class="lb-stat-value" title="${escapeHtml(value)}">${escapeHtml(value)}</div>
      <div class="lb-stat-sub">${escapeHtml(sub)}</div>
    </article>`;
  }

  function renderSummary(snapshot, rows) {
    const ranked = rows.filter((row) => finiteNumber(row.globalRank) != null);
    const leader = ranked[0];
    const topHundred = ranked.filter((row) => Number(row.globalRank) <= 100).length;
    const improving = ranked.filter((row) => finiteNumber(row.dailyRankChange) > 0).length;
    const fresh = rows.filter((row) => row.fresh).length;
    els.summary.innerHTML = [
      summaryCard("Network leader", leader?.name || "—", leader ? `${formatRank(leader.globalRank)} globally` : "Waiting for rank data", "#fbbf24"),
      summaryCard("Global top 100", String(topHundred), `${topHundred} of ${ranked.length || rows.length} ranked clubs`, "#60a5fa"),
      summaryCard("Improving today", String(improving), "Better global rank than yesterday", "#34d399"),
      summaryCard("Fresh API rows", `${fresh}/${rows.length}`, snapshot.complete ? "All clubs refreshed" : "Stale rows remain visible", fresh === rows.length ? "#34d399" : "#fbbf24"),
    ].join("");
  }

  function renderPodium(rows) {
    const ranked = rows.filter((row) => finiteNumber(row.globalRank) != null).slice(0, 3);
    const classes = ["first", "second", "third"];
    els.podium.innerHTML = ranked.length ? ranked.map((row, index) => {
      const tier = tierForRank(row.globalRank);
      return `<a class="lb-podium-card ${classes[index]}" href="./club.html?id=${encodeURIComponent(row.id)}">
        <span class="lb-podium-place">${index + 1}</span>
        <span>
          <span class="lb-podium-name">${escapeHtml(row.name)}</span>
          <span class="lb-podium-officer">${escapeHtml(row.officer || "Officer not listed")}</span>
        </span>
        <span class="lb-podium-rank">
          <img src="${rankIcon(row.globalRank)}" alt="${escapeHtml(tier.name)} rank icon"/>
          <strong>${formatRank(row.globalRank)}</strong>
          <small>Global rank</small>
        </span>
      </a>`;
    }).join("") : '<div class="lb-loading-row">No ranked clubs are available yet.</div>';
  }

  function renderTable(rows) {
    els.body.innerHTML = rows.map((row, index) => {
      const globalRank = finiteNumber(row.globalRank);
      const tier = tierForRank(globalRank);
      const update = row.lastLiveUpdate || row.apiLastUpdated || row.fetchedAt;
      const sourceLabel = row.rankSource === "live" ? "Live rank" : row.rankSource === "monthly" ? "Monthly fallback" : "Fallback data";
      return `<tr class="${row.fresh ? "" : "stale"}">
        <td data-label="Network"><span class="lb-network-place">${finiteNumber(row.networkPosition) ?? index + 1}</span></td>
        <td data-label="Club">
          <a class="lb-club-link" href="./club.html?id=${encodeURIComponent(row.id)}">
            <img class="lb-club-icon" src="${rankIcon(globalRank)}" alt=""/>
            <span>
              <span class="lb-club-name">${escapeHtml(row.name)}</span>
              <span class="lb-club-meta"><span class="lb-quota-tier">${escapeHtml(row.networkTier || "—")}</span> network tier · ${escapeHtml(row.officer || "No officer listed")}</span>
            </span>
          </a>
        </td>
        <td data-label="Global rank">
          <div class="lb-rank-cell"><span><strong>${formatRank(globalRank)}</strong><small>${escapeHtml(tier.name)} official tier</small></span></div>
        </td>
        <td data-label="Today">${movementMarkup(row)}</td>
        <td data-label="Monthly points"><span class="lb-points">${formatPoints(row.points)}<small>${escapeHtml(row.pointsSource === "live" ? "Live points" : "Displayed monthly points")}</small></span></td>
        <td data-label="Roster"><span class="lb-roster">${finiteNumber(row.memberCount) ?? "—"}/30</span></td>
        <td data-label="Source update"><span class="lb-row-update" title="${escapeHtml(exactTime(update))}">${escapeHtml(relativeTime(update))}<br/><span class="${row.fresh ? "" : "stale"}">${row.fresh ? escapeHtml(sourceLabel) : "Stale · preserved"}</span></span></td>
      </tr>`;
    }).join("");
  }

  function renderStatus(snapshot, usedFallback) {
    const updatedAt = snapshot.bootstrap ? snapshot.sourceUpdatedAt : snapshot.updatedAt;
    document.querySelector(".lb-source-pill").textContent = snapshot.bootstrap ? "Data: Chronogenesis fallback" : "Data snapshot: uma.moe";
    const ageMs = safeDate(updatedAt) ? Date.now() - new Date(updatedAt).getTime() : Infinity;
    const expectedMinutes = Math.max(5, finiteNumber(snapshot.expectedRefreshMinutes) || 60);
    const stale = ageMs > Math.max(20, expectedMinutes * 2.25) * 60 * 1000;

    els.updated.textContent = updatedAt ? `Snapshot ${relativeTime(updatedAt)} · ${exactTime(updatedAt)}` : "Snapshot time unavailable";
    if (usedFallback || snapshot.bootstrap) {
      els.status.className = "lb-status warning";
      els.status.innerHTML = '<span class="lb-status-icon" aria-hidden="true">●</span><span>Waiting for the first uma.moe cron snapshot. The current Chronogenesis ranks are shown as a clearly marked fallback.</span>';
    } else if (!snapshot.complete) {
      els.status.className = "lb-status warning";
      els.status.innerHTML = `<span class="lb-status-icon" aria-hidden="true">●</span><span>${Number(snapshot.freshCount) || 0} of ${snapshot.clubs.length} clubs refreshed. Older values were preserved for the remaining clubs.</span>`;
    } else if (stale) {
      els.status.className = "lb-status warning";
      els.status.innerHTML = `<span class="lb-status-icon" aria-hidden="true">●</span><span>The last cron snapshot is ${escapeHtml(relativeTime(updatedAt))}. Rankings remain visible, but the scheduled updater may need attention.</span>`;
    } else {
      els.status.className = "lb-status ok";
      els.status.innerHTML = `<span class="lb-status-icon" aria-hidden="true">●</span><span>All ${snapshot.clubs.length} network clubs loaded from the latest uma.moe snapshot.</span>`;
    }
  }

  function render(snapshot, usedFallback = false) {
    if (!snapshot || !Array.isArray(snapshot.clubs) || snapshot.clubs.length === 0) throw new Error("The leaderboard snapshot did not contain club rows.");
    const rows = [...snapshot.clubs].sort((a, b) => {
      const aRank = finiteNumber(a.globalRank) ?? Infinity;
      const bRank = finiteNumber(b.globalRank) ?? Infinity;
      return aRank - bRank || String(a.name).localeCompare(String(b.name));
    });
    rows.forEach((row, index) => { row.networkPosition = index + 1; });
    renderStatus(snapshot, usedFallback);
    renderSummary(snapshot, rows);
    renderPodium(rows);
    renderTable(rows);
  }

  async function loadLeaderboard() {
    if (loading) return;
    loading = true;
    els.refresh.disabled = true;
    els.refresh.classList.add("refreshing");
    try {
      let snapshot;
      let fallback = false;
      try {
        snapshot = await fetchJson(DATA_PATH);
      } catch (error) {
        console.warn("Scheduled leaderboard snapshot was unavailable; loading the Chronogenesis fallback.", error);
        snapshot = await buildFallbackSnapshot();
        fallback = true;
      }
      render(snapshot, fallback);
    } catch (error) {
      console.error(error);
      els.status.className = "lb-status error";
      els.status.innerHTML = `<span class="lb-status-icon" aria-hidden="true">●</span><span>Leaderboard data could not be loaded: ${escapeHtml(error.message || error)}</span>`;
    } finally {
      loading = false;
      els.refresh.disabled = false;
      els.refresh.classList.remove("refreshing");
      nextRefreshAt = Date.now() + AUTO_REFRESH_MS;
    }
  }

  function updateCountdown() {
    const seconds = Math.max(0, Math.ceil((nextRefreshAt - Date.now()) / 1000));
    const minutes = Math.floor(seconds / 60);
    els.countdown.textContent = `Browser refresh in ${minutes}:${String(seconds % 60).padStart(2, "0")}`;
    if (seconds === 0 && !loading) loadLeaderboard();
  }

  els.refresh.addEventListener("click", loadLeaderboard);
  updateCountdown();
  setInterval(updateCountdown, 1000);
  loadLeaderboard();
})();
