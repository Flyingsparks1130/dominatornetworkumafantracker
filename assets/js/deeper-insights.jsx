(function attachDeeperInsightsPage() {
  const { useEffect, useMemo, useState } = React;
  const A = window.DominatorInsights;

  const COLORS = ["#7c3aed", "#2563eb", "#059669", "#d97706", "#dc2626", "#0891b2", "#db2777", "#65a30d", "#9333ea", "#ea580c", "#64748b"];
  const PANEL = { background: "rgba(17,16,40,0.92)", border: "1px solid #1e1b35", borderRadius: 14, padding: "16px 18px" };
  const MUTED = { color: "#6b7280", fontSize: 11, lineHeight: 1.5 };

  const fmt = (value) => {
    if (value == null || !Number.isFinite(Number(value))) return "—";
    const number = Number(value);
    const absolute = Math.abs(number);
    const sign = number < 0 ? "-" : "";
    if (absolute >= 1_000_000_000) return `${sign}${(absolute / 1_000_000_000).toFixed(2)}B`;
    if (absolute >= 1_000_000) return `${sign}${(absolute / 1_000_000).toFixed(2)}M`;
    if (absolute >= 1_000) return `${sign}${(absolute / 1_000).toFixed(1)}K`;
    return `${sign}${Math.round(absolute).toLocaleString()}`;
  };
  const pct = (value, digits = 1) => value == null || !Number.isFinite(Number(value)) ? "—" : `${(Number(value) * 100).toFixed(digits)}%`;
  const monthLabel = (monthKey) => {
    const match = String(monthKey || "").match(/^(\d{4})-(\d{2})$/);
    if (!match) return monthKey || "Unknown month";
    return new Date(Number(match[1]), Number(match[2]) - 1, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" });
  };

  function Badge({ children, color = "#9ca3af" }) {
    return <span style={{ display: "inline-flex", alignItems: "center", borderRadius: 999, padding: "3px 8px", border: `1px solid ${color}55`, background: `${color}18`, color, fontSize: 10, fontWeight: 800, whiteSpace: "nowrap" }}>{children}</span>;
  }

  function MetricCard({ label, value, sub, color = "#e2e0f0" }) {
    return (
      <div style={{ ...PANEL, padding: "13px 15px", minHeight: 92 }}>
        <div style={{ color: "#6b7280", fontSize: 10, fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 5 }}>{label}</div>
        <div style={{ color, fontSize: 20, fontWeight: 800 }}>{value}</div>
        {sub && <div style={{ ...MUTED, marginTop: 4 }}>{sub}</div>}
      </div>
    );
  }

  function EmptyState({ title, detail }) {
    return <div style={{ ...PANEL, textAlign: "center", padding: "34px 20px" }}><div style={{ color: "#c7c4dd", fontSize: 14, fontWeight: 800, marginBottom: 5 }}>{title}</div><div style={MUTED}>{detail}</div></div>;
  }

  async function fetchArchiveSnapshot(clubId, monthKey) {
    const filename = `${clubId}_${monthKey}.json`;
    const candidates = [`./data/chronogenesis/archive/${filename}`, `/data/chronogenesis/archive/${filename}`];
    for (const url of candidates) {
      try {
        const response = await fetch(url, { headers: { Accept: "application/json" }, cache: "force-cache" });
        if (!response.ok) continue;
        const snapshot = A.parseArchiveSnapshot(await response.json());
        if (snapshot) return snapshot;
      } catch (error) {}
    }
    return null;
  }

  function ForecastTable({ clubs, snapshotsById, forecastsById, selectedClubId, setSelectedClubId }) {
    return (
      <div style={{ ...PANEL, overflow: "hidden", padding: 0 }}>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 1060 }}>
            <thead>
              <tr style={{ background: "rgba(11,9,24,0.82)" }}>
                {["Club", "As-of Gain", "Club Target", "Month-end Forecast", "Directional Range", "Target Outlook", "Projected Global Rank", "Confidence"].map((header) => <th key={header} style={{ color: "#6b7280", textAlign: "left", fontSize: 9, textTransform: "uppercase", letterSpacing: "0.08em", padding: "11px 12px", borderBottom: "1px solid #1e1b35", whiteSpace: "nowrap" }}>{header}</th>)}
              </tr>
            </thead>
            <tbody>
              {clubs.map((club) => {
                const snapshot = snapshotsById[club.id];
                const forecast = forecastsById[club.id];
                const selected = String(club.id) === String(selectedClubId);
                return (
                  <tr key={club.id} onClick={() => snapshot && setSelectedClubId(String(club.id))} style={{ cursor: snapshot ? "pointer" : "default", background: selected ? "rgba(124,58,237,0.12)" : "transparent", borderBottom: "1px solid #17152a" }}>
                    <td style={{ padding: "11px 12px" }}><div style={{ color: "#e2e0f0", fontWeight: 800, fontSize: 12 }}>{club.name}</div><div style={{ color: "#6b7280", fontSize: 9 }}>{club.tier} · {snapshot ? `${snapshot.activeMemberCount} active` : "No JSON"}</div></td>
                    {!snapshot || !forecast ? <td colSpan="7" style={{ padding: "11px 12px", color: "#6b7280", fontSize: 11 }}>Forecast unavailable until a current Chronogenesis JSON exists.</td> : <>
                      <td style={{ padding: "11px 12px", color: "#e2e0f0", fontWeight: 700, fontSize: 11 }}>{fmt(forecast.currentGain)}</td>
                      <td style={{ padding: "11px 12px", fontSize: 11 }}><div style={{ color: "#c4b5fd", fontWeight: 700 }}>{fmt(snapshot.clubTarget)}</div><div style={{ color: "#4b5563", fontSize: 9 }}>{fmt(snapshot.perMemberTarget)} × {snapshot.activeMemberCount}</div></td>
                      <td style={{ padding: "11px 12px", color: "#e2e0f0", fontWeight: 800, fontSize: 12 }}>{fmt(forecast.forecast)}</td>
                      <td style={{ padding: "11px 12px", color: "#9ca3af", fontSize: 11 }}>{fmt(forecast.low)} – {fmt(forecast.high)}</td>
                      <td style={{ padding: "11px 12px" }}><Badge color={forecast.outlook.color}>{forecast.outlook.label}</Badge></td>
                      <td style={{ padding: "11px 12px", color: "#e2e0f0", fontSize: 11, fontWeight: 700 }}>{forecast.projectedRank ? <><div>#{forecast.projectedRank.toLocaleString()}</div><div style={{ color: "#4b5563", fontSize: 9 }}>#{forecast.rankLow?.toLocaleString()}–#{forecast.rankHigh?.toLocaleString()}</div></> : "Insufficient history"}</td>
                      <td style={{ padding: "11px 12px" }}><Badge color={forecast.confidenceColor}>{forecast.confidence}</Badge><div style={{ color: "#4b5563", fontSize: 9, marginTop: 4 }}>{forecast.historicalSamples} club analogs</div></td>
                    </>}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  function ContributionDonut({ resilience, expanded, setExpanded }) {
    if (!resilience?.contributions?.length) return <EmptyState title="No contribution data" detail="Player contribution history is not available for this club and day." />;
    const visibleLimit = expanded ? resilience.contributions.length : 10;
    const firstRows = resilience.contributions.slice(0, visibleLimit);
    const hiddenRows = resilience.contributions.slice(visibleLimit);
    const displayRows = hiddenRows.length ? [...firstRows, { name: `Other ${hiddenRows.length} contributors`, gain: A.sum(hiddenRows.map((row) => row.gain)), share: A.sum(hiddenRows.map((row) => row.share)), isGrouped: true }] : firstRows;
    let angle = 0;
    const stops = displayRows.map((row, index) => {
      const start = angle;
      angle += row.share * 360;
      return `${COLORS[index % COLORS.length]} ${start.toFixed(2)}deg ${angle.toFixed(2)}deg`;
    });
    if (angle < 360) stops.push(`#252238 ${angle.toFixed(2)}deg 360deg`);
    return (
      <div style={{ display: "grid", gridTemplateColumns: "minmax(190px, 260px) minmax(260px, 1fr)", gap: 22, alignItems: "center" }} className="insights-donut-grid">
        <div style={{ display: "flex", justifyContent: "center" }}>
          <div title="Player contribution share" style={{ width: 220, aspectRatio: "1", borderRadius: "50%", background: `conic-gradient(${stops.join(",")})`, position: "relative", boxShadow: "0 0 30px rgba(124,58,237,0.12)" }}>
            <div style={{ position: "absolute", inset: "27%", borderRadius: "50%", background: "#111028", border: "1px solid #2a2540", display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center", textAlign: "center", padding: 8 }}><div style={{ color: "#e2e0f0", fontWeight: 800, fontSize: 16 }}>{fmt(resilience.totalGain)}</div><div style={{ color: "#6b7280", fontSize: 9 }}>club gain</div></div>
          </div>
        </div>
        <div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {displayRows.map((row, index) => <div key={`${row.name}-${index}`} title={`${row.name}: ${Math.round(row.gain).toLocaleString()} fans (${pct(row.share)})`} style={{ display: "grid", gridTemplateColumns: "10px minmax(120px,1fr) auto auto", gap: 8, alignItems: "center", fontSize: 10 }}><span style={{ width: 8, height: 8, borderRadius: 999, background: COLORS[index % COLORS.length] }} /><span style={{ color: "#c7c4dd", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{row.name}</span><span style={{ color: "#9ca3af", fontWeight: 700 }}>{fmt(row.gain)}</span><span style={{ color: "#e2e0f0", fontWeight: 800, minWidth: 48, textAlign: "right" }}>{pct(row.share)}</span></div>)}
          </div>
          {resilience.contributions.length > 10 && <button onClick={() => setExpanded(!expanded)} style={{ marginTop: 12, background: "#17152a", border: "1px solid #2a2540", color: "#c4b5fd", borderRadius: 8, padding: "6px 9px", fontSize: 10, fontWeight: 800, cursor: "pointer" }}>{expanded ? "Show top 10 + grouped remainder" : `Show all ${resilience.contributions.length} contributors`}</button>}
        </div>
      </div>
    );
  }

  function DeeperInsightsPage({ clubs = [], clubData = {}, archiveManifest = null, today = 1, dim = 31, monthKey = "", archiveMonth = "", isArchiveView = false }) {
    const snapshots = useMemo(() => clubs.map((club) => A.buildCurrentSnapshot(club, clubData[club.id], dim)).filter(Boolean), [clubs, clubData, dim]);
    const snapshotsById = useMemo(() => Object.fromEntries(snapshots.map((snapshot) => [snapshot.clubId, snapshot])), [snapshots]);
    const latestDay = Math.max(1, Math.min(today, ...snapshots.map((snapshot) => snapshot.maxAvailableDay).filter((day) => day > 0), today));
    const [analysisDay, setAnalysisDay] = useState(latestDay);
    const [activeSection, setActiveSection] = useState("forecast");
    const [selectedClubId, setSelectedClubId] = useState(() => snapshots[0]?.clubId || clubs[0]?.id || "");
    const [historyByClub, setHistoryByClub] = useState({});
    const [historyStatus, setHistoryStatus] = useState({ loading: false, loaded: 0, total: 0, failed: 0 });
    const [contributionExpanded, setContributionExpanded] = useState(false);
    const [profileExpanded, setProfileExpanded] = useState({});

    useEffect(() => { setAnalysisDay(latestDay); }, [latestDay, monthKey, archiveMonth]);
    useEffect(() => {
      if (!snapshots.length) return;
      if (!snapshotsById[selectedClubId]) setSelectedClubId(snapshots[0].clubId);
    }, [snapshots, snapshotsById, selectedClubId]);
    useEffect(() => { setContributionExpanded(false); }, [selectedClubId, analysisDay]);

    useEffect(() => {
      if (!archiveManifest || !snapshots.length) return undefined;
      let cancelled = false;
      const tasks = [];
      snapshots.forEach((snapshot) => {
        const months = Array.isArray(archiveManifest?.clubs?.[snapshot.clubId]) ? archiveManifest.clubs[snapshot.clubId] : [];
        months.filter((candidate) => candidate < snapshot.monthKey).sort((a, b) => b.localeCompare(a)).slice(0, 3).forEach((candidate) => tasks.push({ clubId: snapshot.clubId, monthKey: candidate }));
      });
      setHistoryByClub({});
      setHistoryStatus({ loading: tasks.length > 0, loaded: 0, total: tasks.length, failed: 0 });
      let cursor = 0;
      const worker = async () => {
        while (!cancelled && cursor < tasks.length) {
          const task = tasks[cursor++];
          const snapshot = await fetchArchiveSnapshot(task.clubId, task.monthKey);
          if (cancelled) return;
          if (snapshot) setHistoryByClub((previous) => ({ ...previous, [task.clubId]: [...(previous[task.clubId] || []), snapshot].sort((a, b) => b.monthKey.localeCompare(a.monthKey)) }));
          setHistoryStatus((previous) => ({ ...previous, loaded: previous.loaded + (snapshot ? 1 : 0), failed: previous.failed + (snapshot ? 0 : 1), loading: previous.loaded + previous.failed + 1 < previous.total }));
        }
      };
      Promise.all(Array.from({ length: Math.min(5, tasks.length) }, () => worker()));
      return () => { cancelled = true; };
    }, [archiveManifest, monthKey, archiveMonth, snapshots.map((snapshot) => `${snapshot.clubId}:${snapshot.monthKey}`).join("|")]);

    const rankHistoryPool = useMemo(() => Object.values(historyByClub).flat(), [historyByClub]);
    const forecastsById = useMemo(() => Object.fromEntries(snapshots.map((snapshot) => [snapshot.clubId, A.forecastClub(snapshot, historyByClub[snapshot.clubId] || [], analysisDay, rankHistoryPool)])), [snapshots, historyByClub, analysisDay, rankHistoryPool]);
    const overall = useMemo(() => {
      const forecasts = snapshots.map((snapshot) => ({ snapshot, forecast: forecastsById[snapshot.clubId] })).filter((entry) => entry.forecast);
      return {
        current: A.sum(forecasts.map((entry) => entry.forecast.currentGain)),
        forecast: A.sum(forecasts.map((entry) => entry.forecast.forecast)),
        low: A.sum(forecasts.map((entry) => entry.forecast.low)),
        high: A.sum(forecasts.map((entry) => entry.forecast.high)),
        target: A.sum(forecasts.map((entry) => entry.snapshot.clubTarget)),
        aboveTarget: forecasts.filter((entry) => entry.forecast.forecast >= entry.snapshot.clubTarget).length,
        clubCount: forecasts.length,
      };
    }, [snapshots, forecastsById]);
    const selectedSnapshot = snapshotsById[selectedClubId] || snapshots[0] || null;
    const selectedForecast = selectedSnapshot ? forecastsById[selectedSnapshot.clubId] : null;
    const twins = useMemo(() => selectedSnapshot ? A.findHistoricalTwins(selectedSnapshot, historyByClub[selectedSnapshot.clubId] || [], analysisDay) : [], [selectedSnapshot, historyByClub, analysisDay]);
    const momentumByClub = useMemo(() => Object.fromEntries(snapshots.map((snapshot) => [snapshot.clubId, A.computeMomentum(snapshot, analysisDay)])), [snapshots, analysisDay]);
    const selectedMomentum = selectedSnapshot ? momentumByClub[selectedSnapshot.clubId] : null;
    const clubMomentumAlerts = snapshots.map((snapshot) => ({ snapshot, alert: momentumByClub[snapshot.clubId]?.clubAlert })).filter((entry) => entry.alert);
    const networkMemberAlerts = snapshots.flatMap((snapshot) => (momentumByClub[snapshot.clubId]?.memberAlerts || []).map((alert) => ({ ...alert, clubName: snapshot.clubName }))).sort((a, b) => b.projectedImpact - a.projectedImpact);
    const resilience = useMemo(() => selectedSnapshot ? A.computeResilience(selectedSnapshot, analysisDay) : null, [selectedSnapshot, analysisDay]);
    const profiles = useMemo(() => A.profileMembers(snapshots, analysisDay), [snapshots, analysisDay]);

    const sections = [
      ["forecast", "📡 Forecasts"],
      ["momentum", "⚡ Momentum & Resilience"],
      ["twins", "🪞 Historical Twins"],
      ["profiles", "🧬 Member Archetypes"],
    ];
    const sliderStops = [5, 10, 15, 20, 25, latestDay].filter((day, index, values) => day <= latestDay && values.indexOf(day) === index);
    const selectedClub = clubs.find((club) => String(club.id) === String(selectedClubId));

    if (!A) return <EmptyState title="Insights analytics failed to load" detail="Reload the page. The Chronogenesis data has not been modified." />;
    if (!snapshots.length) return <EmptyState title="Waiting for Chronogenesis data" detail="No current club JSON was available to analyze. Dominarium will remain unavailable until its external feed creates a JSON file." />;

    return (
      <div>
        <div style={{ ...PANEL, marginBottom: 14, background: "linear-gradient(135deg, rgba(124,58,237,0.16), rgba(17,16,40,0.94) 48%, rgba(37,99,235,0.10))" }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 16, alignItems: "flex-start", flexWrap: "wrap" }}>
            <div style={{ maxWidth: 760 }}><div style={{ color: "#f1eefc", fontSize: 25, fontWeight: 900 }}>Deeper Insights</div><div style={{ color: "#8f88b8", fontSize: 12, lineHeight: 1.65, marginTop: 5 }}>Target-aware, read-only analysis from the daily Chronogenesis files already in this repository. Forecasts are directional estimates with explicit uncertainty—not guaranteed outcomes.</div></div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}><Badge color="#a78bfa">{monthLabel(monthKey || snapshots[0]?.monthKey)}</Badge><Badge color={isArchiveView ? "#c4b5fd" : "#34d399"}>{isArchiveView ? "Archive analysis" : "Live dataset"}</Badge><Badge color={historyStatus.loading ? "#fbbf24" : "#60a5fa"}>{historyStatus.loading ? `Loading history ${historyStatus.loaded + historyStatus.failed}/${historyStatus.total}` : `${historyStatus.loaded} history files loaded`}</Badge></div>
          </div>
          <div style={{ marginTop: 16, display: "grid", gridTemplateColumns: "minmax(230px,1fr) auto", gap: 14, alignItems: "end" }} className="insights-day-control">
            <div><div style={{ display: "flex", justifyContent: "space-between", gap: 8, marginBottom: 7 }}><span style={{ color: "#c7c4dd", fontSize: 11, fontWeight: 800 }}>Analyze as of Day {analysisDay}</span><span style={{ color: "#6b7280", fontSize: 10 }}>Latest available: Day {latestDay}</span></div><input aria-label="Analysis day" type="range" min="1" max={latestDay} value={analysisDay} onChange={(event) => setAnalysisDay(Number(event.target.value))} style={{ width: "100%", accentColor: "#7c3aed" }} /></div>
            <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>{sliderStops.map((day) => <button key={day} onClick={() => setAnalysisDay(day)} style={{ background: analysisDay === day ? "#7c3aed" : "#17152a", border: `1px solid ${analysisDay === day ? "#8b5cf6" : "#2a2540"}`, color: "#e2e0f0", borderRadius: 8, padding: "6px 8px", fontSize: 9, fontWeight: 800, cursor: "pointer" }}>Day {day}</button>)}</div>
          </div>
          {latestDay >= dim && analysisDay >= dim && <div style={{ marginTop: 10, color: "#fbbf24", fontSize: 10 }}>This month is complete, so the table shows actual month-end results. Move the day slider backward to replay and test the forecast without future-day leakage.</div>}
        </div>

        <div style={{ display: "flex", gap: 7, flexWrap: "wrap", marginBottom: 14 }}>{sections.map(([key, label]) => <button key={key} onClick={() => setActiveSection(key)} style={{ background: activeSection === key ? "#7c3aed" : "#111028", border: `1px solid ${activeSection === key ? "#8b5cf6" : "#1e1b35"}`, color: activeSection === key ? "#fff" : "#9ca3af", borderRadius: 9, padding: "8px 11px", fontSize: 10, fontWeight: 800, cursor: "pointer" }}>{label}</button>)}</div>

        {activeSection === "forecast" && <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(175px,1fr))", gap: 10, marginBottom: 14 }}>
            <MetricCard label="Network gain as of day" value={fmt(overall.current)} sub={`${overall.clubCount}/${clubs.length} clubs with data`} />
            <MetricCard label="Network month-end forecast" value={fmt(overall.forecast)} sub={`${fmt(overall.low)} – ${fmt(overall.high)} directional range`} color="#c4b5fd" />
            <MetricCard label="Combined club target" value={fmt(overall.target)} sub="Per-member quota × active roster" color="#60a5fa" />
            <MetricCard label="Clubs forecast above target" value={`${overall.aboveTarget}/${overall.clubCount}`} sub="Based on midpoint, not a probability" color="#34d399" />
          </div>
          <ForecastTable clubs={clubs} snapshotsById={snapshotsById} forecastsById={forecastsById} selectedClubId={selectedClubId} setSelectedClubId={setSelectedClubId} />
          {selectedSnapshot && selectedForecast && <div style={{ ...PANEL, marginTop: 14 }}><div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}><div><div style={{ color: "#e2e0f0", fontWeight: 800, fontSize: 13 }}>{selectedSnapshot.clubName} forecast explanation</div><div style={{ ...MUTED, marginTop: 4 }}>{selectedForecast.method}. Target: {fmt(selectedSnapshot.perMemberTarget)} per member × {selectedSnapshot.activeMemberCount} active = {fmt(selectedSnapshot.clubTarget)}.</div></div><Badge color={selectedForecast.confidenceColor}>{selectedForecast.confidence} confidence</Badge></div><div style={{ ...MUTED, marginTop: 9 }}>Global rank estimate uses comparable historical daily rank movement across the loaded network archives. External clubs are not directly observed, so the rank range is intentionally wide.</div></div>}
        </>}

        {activeSection === "momentum" && <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(210px,1fr))", gap: 10, marginBottom: 14 }}>
            <MetricCard label="Material club shifts" value={clubMomentumAlerts.length} sub="Requires several members moving together" color={clubMomentumAlerts.length ? "#fbbf24" : "#34d399"} />
            <MetricCard label="Large member variances" value={networkMemberAlerts.length} sub="Filtered for both relative size and target impact" color={networkMemberAlerts.length ? "#f97316" : "#34d399"} />
            <MetricCard label="Selected club" value={selectedClub?.name || selectedSnapshot?.clubName || "—"} sub={`Analysis through Day ${analysisDay}`} color="#c4b5fd" />
          </div>
          <div style={{ ...PANEL, marginBottom: 14 }}><div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 12 }}><div><div style={{ color: "#e2e0f0", fontSize: 14, fontWeight: 800 }}>Significant momentum only</div><div style={MUTED}>A member must move at least 75% versus their preceding seven-day baseline and create a material projected effect on the club target.</div></div><select value={selectedClubId} onChange={(event) => setSelectedClubId(event.target.value)} style={{ background: "#0c0b18", border: "1px solid #2a2540", color: "#e2e0f0", borderRadius: 8, padding: "7px 9px", fontSize: 10 }}>{snapshots.map((snapshot) => <option key={snapshot.clubId} value={snapshot.clubId}>{snapshot.clubName}</option>)}</select></div>
            {!selectedMomentum?.ready ? <div style={MUTED}>{selectedMomentum?.reason || "No momentum data."}</div> : selectedMomentum.memberAlerts.length ? <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>{selectedMomentum.clubAlert && <div style={{ border: `1px solid ${selectedMomentum.clubAlert.direction === "up" ? "#34d39955" : "#f8717155"}`, background: selectedMomentum.clubAlert.direction === "up" ? "#34d39912" : "#f8717112", borderRadius: 10, padding: "10px 12px", color: selectedMomentum.clubAlert.direction === "up" ? "#34d399" : "#f87171", fontSize: 11, fontWeight: 800 }}>Club-level {selectedMomentum.clubAlert.direction === "up" ? "acceleration" : "slowdown"}: {selectedMomentum.clubAlert.affectedMembers} members are moving together with an estimated {fmt(selectedMomentum.clubAlert.combinedImpact)} remaining-month target impact.</div>}{selectedMomentum.memberAlerts.slice(0, 10).map((alert) => <div key={alert.viewerId} style={{ display: "grid", gridTemplateColumns: "minmax(130px,1fr) auto auto auto", gap: 12, alignItems: "center", borderBottom: "1px solid #1e1b35", padding: "8px 2px", fontSize: 10 }}><div style={{ color: "#e2e0f0", fontWeight: 800 }}>{alert.name}</div><div style={{ color: "#6b7280" }}>Baseline <b style={{ color: "#9ca3af" }}>{fmt(alert.baselineAverage)}/day</b></div><div style={{ color: "#6b7280" }}>Recent <b style={{ color: alert.direction === "up" ? "#34d399" : "#f87171" }}>{fmt(alert.recentAverage)}/day</b></div><div style={{ color: alert.direction === "up" ? "#34d399" : "#f87171", fontWeight: 800 }}>{Number.isFinite(alert.relativeChange) ? `${alert.relativeChange >= 0 ? "+" : ""}${Math.round(alert.relativeChange * 100)}%` : "New activity"}</div></div>)}</div> : <div style={MUTED}>No member variance is large and material enough to surface for this club and day.</div>}
          </div>
          <div style={{ ...PANEL }}><div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap", marginBottom: 14 }}><div><div style={{ color: "#e2e0f0", fontSize: 14, fontWeight: 800 }}>Monthly Contribution Pie — {selectedSnapshot?.clubName}</div><div style={MUTED}>Each player’s cumulative gain divided by total club gain as of Day {analysisDay}. Departed or unmatched contribution is retained as “Other / roster changes.”</div></div>{resilience?.sustainedConcentration ? <Badge color="#f87171">Concentration risk</Badge> : <Badge color="#34d399">No sustained warning</Badge>}</div>
            {resilience && <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(145px,1fr))", gap: 8, marginBottom: 18 }}><MetricCard label="Top player share" value={pct(resilience.topOneShare)} /><MetricCard label="Top 3 share" value={pct(resilience.topThreeShare)} /><MetricCard label="Top 5 share" value={pct(resilience.topFiveShare)} sub={`${resilience.concentrationChange >= 0 ? "+" : ""}${(resilience.concentrationChange * 100).toFixed(1)} pts vs Day ${Math.max(1, analysisDay - 7)}`} color={resilience.sustainedConcentration ? "#f87171" : "#fbbf24"} /><MetricCard label="Effective contributors" value={resilience.effectiveContributors.toFixed(1)} sub="Concentration-adjusted count" color="#60a5fa" /></div>}
            {resilience?.alert && <div style={{ color: "#f87171", background: "#f8717110", border: "1px solid #f8717144", borderRadius: 9, padding: "9px 11px", fontSize: 10, fontWeight: 700, marginBottom: 16 }}>{resilience.alert}</div>}
            <ContributionDonut resilience={resilience} expanded={contributionExpanded} setExpanded={setContributionExpanded} />
          </div>
        </>}

        {activeSection === "twins" && <div style={PANEL}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 14 }}><div><div style={{ color: "#e2e0f0", fontSize: 14, fontWeight: 800 }}>Club-level Historical Twins</div><div style={MUTED}>Compares the selected club’s target-normalized trajectory through Day {analysisDay} with up to three earlier completed months for the same club.</div></div><select value={selectedClubId} onChange={(event) => setSelectedClubId(event.target.value)} style={{ background: "#0c0b18", border: "1px solid #2a2540", color: "#e2e0f0", borderRadius: 8, padding: "7px 9px", fontSize: 10 }}>{snapshots.map((snapshot) => <option key={snapshot.clubId} value={snapshot.clubId}>{snapshot.clubName}</option>)}</select></div>
          {historyStatus.loading && !twins.length ? <div style={MUTED}>Loading the latest historical snapshots for this club…</div> : twins.length ? <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))", gap: 10 }}>{twins.map((twin, index) => <div key={twin.monthKey} style={{ background: "#0c0b18", border: `1px solid ${index === 0 ? "#7c3aed88" : "#1e1b35"}`, borderRadius: 12, padding: "14px 15px" }}><div style={{ display: "flex", justifyContent: "space-between", gap: 8, marginBottom: 10 }}><div style={{ color: "#e2e0f0", fontWeight: 800 }}>{monthLabel(twin.monthKey)}</div><Badge color={index === 0 ? "#a78bfa" : "#60a5fa"}>{twin.similarity}% similar</Badge></div><div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, fontSize: 10 }}><div><div style={{ color: "#4b5563" }}>Day {analysisDay} progress</div><div style={{ color: "#c4b5fd", fontWeight: 800 }}>{pct(twin.progressAtDay)}</div></div><div><div style={{ color: "#4b5563" }}>Final target result</div><div style={{ color: twin.finalProgress >= 1 ? "#34d399" : "#fbbf24", fontWeight: 800 }}>{pct(twin.finalProgress)}</div></div><div><div style={{ color: "#4b5563" }}>Final club gain</div><div style={{ color: "#e2e0f0", fontWeight: 800 }}>{fmt(twin.finalGain)}</div></div><div><div style={{ color: "#4b5563" }}>Global rank movement</div><div style={{ color: "#e2e0f0", fontWeight: 800 }}>{twin.rankAtDay && twin.finalRank ? `#${twin.rankAtDay.toLocaleString()} → #${twin.finalRank.toLocaleString()}` : "Unavailable"}</div></div></div><div style={{ ...MUTED, marginTop: 10 }}>Historical quota: {fmt(twin.perMemberTarget)}/member · {twin.activeMemberCount} active in archived roster</div></div>)}</div> : <EmptyState title="No valid historical twin yet" detail="This club needs an earlier completed archive with a captured target and enough daily history. Dominarium currently has no history, while some clubs have only one usable month." />}
        </div>}

        {activeSection === "profiles" && <div style={PANEL}>
          <div style={{ marginBottom: 14 }}><div style={{ color: "#e2e0f0", fontSize: 14, fontWeight: 800 }}>Network-wide Member Archetypes</div><div style={MUTED}>Rule-based behavioral profiles from daily activity shape, normalized progress, consistency, burst concentration, timing, and recent momentum. These are descriptive—not performance grades.</div></div>
          {!profiles.ready ? <EmptyState title="Not enough elapsed data" detail={profiles.reason} /> : <><div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(230px,1fr))", gap: 10 }}>{profiles.groups.map((group) => { const showAll = Boolean(profileExpanded[group.key]); const visible = showAll ? group.members : group.members.slice(0, 6); return <div key={group.key} style={{ background: "#0c0b18", border: `1px solid ${group.color}44`, borderRadius: 12, padding: "13px 14px" }}><div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginBottom: 9 }}><div style={{ color: group.color, fontWeight: 800, fontSize: 12 }}>{group.label}</div><Badge color={group.color}>{group.members.length}</Badge></div><div style={{ display: "flex", flexDirection: "column", gap: 6 }}>{visible.map((member) => <div key={`${member.viewerId}-${member.clubName}`} style={{ display: "flex", justifyContent: "space-between", gap: 10, fontSize: 10 }}><div style={{ minWidth: 0 }}><div style={{ color: "#e2e0f0", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{member.name}</div><div style={{ color: "#4b5563", fontSize: 9 }}>{member.clubName}</div></div><div style={{ color: "#9ca3af", fontWeight: 700, whiteSpace: "nowrap" }}>{pct(member.progressRatio)} target</div></div>)}</div>{group.members.length > 6 && <button onClick={() => setProfileExpanded((previous) => ({ ...previous, [group.key]: !showAll }))} style={{ marginTop: 10, background: "transparent", border: 0, color: group.color, fontSize: 9, fontWeight: 800, cursor: "pointer", padding: 0 }}>{showAll ? "Show fewer" : `Show ${group.members.length - 6} more`}</button>}</div>; })}</div><div style={{ ...MUTED, marginTop: 14 }}>Returning-member and cross-club movement archetypes are intentionally excluded from this first version; they belong in the future retention/movement successor to Transfer Helper.</div></>}
        </div>}

        <div style={{ ...PANEL, marginTop: 14, borderColor: "#3a3159" }}><div style={{ color: "#c4b5fd", fontSize: 11, fontWeight: 800, marginBottom: 6 }}>Known analytical limits</div><div style={MUTED}>Only the latest three earlier archives per club are loaded to keep the page practical. Clubs currently have between zero and five completed months, historical rosters are captured at month-end rather than daily, global rank depends on external clubs we cannot observe directly, and all uncertainty ranges are directional backtested ranges rather than formal statistical guarantees. No Chronogenesis file or job is changed by this page.</div></div>
      </div>
    );
  }

  window.DeeperInsightsPage = DeeperInsightsPage;
})();
