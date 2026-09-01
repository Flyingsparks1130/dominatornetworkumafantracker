(function attachDeeperInsightsPage() {
  const { useEffect, useMemo, useState } = React;
  const A = window.DominatorInsights;

  const COLORS = ["#7c3aed", "#2563eb", "#059669", "#d97706", "#dc2626", "#0891b2", "#db2777", "#65a30d", "#9333ea", "#ea580c", "#64748b"];
  const PANEL = { background: "rgba(17,16,40,0.92)", border: "1px solid #1e1b35", borderRadius: 14, padding: "16px 18px" };
  const MUTED = { color: "#6b7280", fontSize: 11, lineHeight: 1.5 };
  const PROFILE_DESCRIPTIONS = {
    anchor: "One of the network’s highest-volume members who also contributes on most days.",
    consistent: "Contributes on most days with relatively stable daily output.",
    weekend: "A noticeably larger share of activity happens on Saturdays and Sundays.",
    late: "Output is becoming substantially stronger in the second half of the month.",
    climber: "The most recent five-day pace is meaningfully higher than the prior five days.",
    burst: "A large share of progress comes from a small number of especially strong days.",
    intermittent: "Contributes meaningfully, but on fewer than six out of every ten days.",
    mixed: "The member does not yet fit one dominant pattern or the pattern is still forming.",
  };

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

  function ExplanationBox({ headline, meaning, action, color = "#60a5fa" }) {
    return <div style={{ background: `${color}0d`, border: `1px solid ${color}44`, borderRadius: 12, padding: "13px 15px", marginBottom: 14 }}>
      <div style={{ color, fontSize: 12, fontWeight: 900, marginBottom: 9 }}>{headline}</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(230px,1fr))", gap: 12 }}>
        <div><div style={{ color: "#8f88b8", fontSize: 9, fontWeight: 900, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 3 }}>What this means</div><div style={{ color: "#c7c4dd", fontSize: 11, lineHeight: 1.55 }}>{meaning}</div></div>
        <div><div style={{ color: "#8f88b8", fontSize: 9, fontWeight: 900, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 3 }}>What to do with it</div><div style={{ color: "#c7c4dd", fontSize: 11, lineHeight: 1.55 }}>{action}</div></div>
      </div>
    </div>;
  }

  function TargetAttainmentDotPlot({ clubs, snapshotsById, forecastsById, selectedClubId, setSelectedClubId, analysisDay }) {
    const rows = clubs.map((club) => ({ club, snapshot: snapshotsById[club.id], forecast: forecastsById[club.id] }))
      .filter((row) => row.snapshot?.clubTarget > 0 && row.forecast)
      .map((row) => ({ ...row, currentRatio: row.forecast.currentGain / row.snapshot.clubTarget, forecastRatio: row.forecast.forecast / row.snapshot.clubTarget, lowRatio: row.forecast.low / row.snapshot.clubTarget, highRatio: row.forecast.high / row.snapshot.clubTarget }))
      .sort((a, b) => b.forecastRatio - a.forecastRatio);
    if (!rows.length) return null;
    const rawMax = Math.max(1.25, ...rows.map((row) => row.highRatio));
    const scaleMax = Math.min(2.5, Math.max(1.25, Math.ceil(rawMax * 4) / 4));
    const position = (ratio) => `${Math.max(0, Math.min(100, (ratio / scaleMax) * 100))}%`;
    const ticks = Array.from(new Set([0, 0.5, 1, 1.5, 2, 2.5, scaleMax].filter((value) => value >= 0 && value <= scaleMax))).sort((a, b) => a - b);
    return <div style={{ ...PANEL, marginBottom: 14 }}>
      <div style={{ marginBottom: 13 }}><div style={{ color: "#e2e0f0", fontSize: 14, fontWeight: 900 }}>Club Target Outlook — Dot Plot</div><div style={MUTED}>The solid dot is the best month-end estimate. The thin line is its working range. The hollow dot is progress already earned through Day {analysisDay}. The vertical goal line marks 100%.</div></div>
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginBottom: 15, fontSize: 9, color: "#9ca3af" }}><span>● Best estimate</span><span>○ Earned so far</span><span style={{ color: "#fbbf24" }}>│ 100% goal</span><span>— Working range</span></div>
      <div style={{ marginLeft: 126, marginRight: 58, height: 18, position: "relative" }} className="insights-dot-axis">{ticks.map((tick) => <span key={tick} style={{ position: "absolute", left: position(tick), transform: "translateX(-50%)", color: tick === 1 ? "#fbbf24" : "#4b5563", fontSize: 8, fontWeight: tick === 1 ? 900 : 600 }}>{Math.round(tick * 100)}%</span>)}</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>{rows.map((row) => {
        const dotColor = row.forecastRatio >= 1 ? "#34d399" : row.highRatio >= 1 ? "#fbbf24" : "#f87171";
        const rangeLeft = Math.min(row.lowRatio, row.highRatio);
        const rangeWidth = Math.max(0, Math.min(scaleMax, row.highRatio) - Math.max(0, rangeLeft));
        return <button key={row.club.id} onClick={() => setSelectedClubId(String(row.club.id))} style={{ display: "grid", gridTemplateColumns: "118px minmax(230px,1fr) 52px", gap: 8, alignItems: "center", background: String(row.club.id) === String(selectedClubId) ? "rgba(124,58,237,0.10)" : "transparent", border: 0, borderRadius: 8, padding: "5px 4px", cursor: "pointer", textAlign: "left" }} className="insights-dot-row">
          <span style={{ color: "#c7c4dd", fontSize: 10, fontWeight: 800, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{row.club.name}</span>
          <span style={{ height: 18, position: "relative", display: "block", background: "#0c0b18", borderRadius: 999, border: "1px solid #1e1b35" }}>
            <span style={{ position: "absolute", left: position(1), top: -3, bottom: -3, borderLeft: "1px dashed #fbbf24aa" }} />
            <span style={{ position: "absolute", left: position(rangeLeft), width: `${(rangeWidth / scaleMax) * 100}%`, top: 8, borderTop: `2px solid ${dotColor}88` }} />
            <span title={`Earned through Day ${analysisDay}: ${pct(row.currentRatio)}`} style={{ position: "absolute", left: position(row.currentRatio), top: 4, width: 8, height: 8, transform: "translateX(-50%)", borderRadius: 999, border: "2px solid #9ca3af", background: "#0c0b18", boxSizing: "border-box" }} />
            <span title={`Forecast: ${pct(row.forecastRatio)}`} style={{ position: "absolute", left: position(row.forecastRatio), top: 3, width: 10, height: 10, transform: "translateX(-50%)", borderRadius: 999, background: dotColor, boxShadow: `0 0 9px ${dotColor}99` }} />
          </span>
          <span style={{ color: dotColor, fontSize: 10, fontWeight: 900, textAlign: "right" }}>{row.forecastRatio > scaleMax ? `${Math.round(row.forecastRatio * 100)}%+` : pct(row.forecastRatio, 0)}</span>
        </button>;
      })}</div>
    </div>;
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
                {["Club", "Gain so far", "Full club goal", "Best month-end estimate", "Working range", "Goal status", "Estimated final rank", "Data confidence"].map((header) => <th key={header} style={{ color: "#6b7280", textAlign: "left", fontSize: 9, textTransform: "uppercase", letterSpacing: "0.08em", padding: "11px 12px", borderBottom: "1px solid #1e1b35", whiteSpace: "nowrap" }}>{header}</th>)}
              </tr>
            </thead>
            <tbody>
              {clubs.map((club) => {
                const snapshot = snapshotsById[club.id];
                const forecast = forecastsById[club.id];
                const selected = String(club.id) === String(selectedClubId);
                return (
                  <tr key={club.id} onClick={() => snapshot && setSelectedClubId(String(club.id))} style={{ cursor: snapshot ? "pointer" : "default", background: selected ? "rgba(124,58,237,0.12)" : "transparent", borderBottom: "1px solid #17152a" }}>
                    <td style={{ padding: "11px 12px" }}><div style={{ color: "#e2e0f0", fontWeight: 800, fontSize: 12 }}>{club.name}</div><div style={{ color: "#6b7280", fontSize: 9 }}>{club.tier} · {snapshot ? `${snapshot.activeMemberCount} active` : "Waiting for data"}</div></td>
                    {!snapshot || !forecast ? <td colSpan="7" style={{ padding: "11px 12px", color: "#6b7280", fontSize: 11 }}>No current club data yet. Analysis will appear when its daily feed exists.</td> : <>
                      <td style={{ padding: "11px 12px", color: "#e2e0f0", fontWeight: 700, fontSize: 11 }}>{fmt(forecast.currentGain)}</td>
                      <td style={{ padding: "11px 12px", fontSize: 11 }}><div style={{ color: "#c4b5fd", fontWeight: 700 }}>{fmt(snapshot.clubTarget)}</div><div style={{ color: "#4b5563", fontSize: 9 }}>{fmt(snapshot.perMemberTarget)} × {snapshot.activeMemberCount}</div></td>
                      <td style={{ padding: "11px 12px", color: "#e2e0f0", fontWeight: 800, fontSize: 12 }}>{fmt(forecast.forecast)}</td>
                      <td style={{ padding: "11px 12px", color: "#9ca3af", fontSize: 11 }}>{fmt(forecast.low)} – {fmt(forecast.high)}</td>
                      <td style={{ padding: "11px 12px" }}><Badge color={forecast.outlook.color}>{forecast.outlook.label}</Badge></td>
                      <td style={{ padding: "11px 12px", color: "#e2e0f0", fontSize: 11, fontWeight: 700 }}>{forecast.projectedRank ? <><div>#{forecast.projectedRank.toLocaleString()}</div><div style={{ color: "#4b5563", fontSize: 9 }}>#{forecast.rankLow?.toLocaleString()}–#{forecast.rankHigh?.toLocaleString()}</div></> : "Insufficient history"}</td>
                      <td style={{ padding: "11px 12px" }}><Badge color={forecast.confidenceColor}>{forecast.confidence}</Badge><div style={{ color: "#4b5563", fontSize: 9, marginTop: 4 }}>{forecast.historicalSamples} similar prior months</div></td>
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

  function TransferHelper({ transferData, snapshots, analysisDay }) {
    const [categoryFilter, setCategoryFilter] = useState("transfer-review");
    const [clubFilter, setClubFilter] = useState("all");
    const [visibleCount, setVisibleCount] = useState(12);
    useEffect(() => { setVisibleCount(12); }, [categoryFilter, clubFilter, analysisDay]);
    if (!transferData?.ready) return <EmptyState title="Transfer recommendations are not ready" detail={transferData?.reason || "More daily history is required."} />;

    const CATEGORY = {
      promote: { label: "Promotion review", color: "#34d399", icon: "↑" },
      "move-down": { label: "Lower-tier review", color: "#f87171", icon: "↓" },
      watch: { label: "Watch and coach", color: "#fbbf24", icon: "!" },
      keep: { label: "Current tier looks suitable", color: "#60a5fa", icon: "✓" },
    };
    const matchesCategory = (item) => categoryFilter === "all"
      || (categoryFilter === "transfer-review" ? ["promote", "move-down"].includes(item.category) : item.category === categoryFilter);
    const filtered = transferData.recommendations.filter((item) => matchesCategory(item) && (clubFilter === "all" || item.clubId === clubFilter));
    const visible = filtered.slice(0, visibleCount);
    const eligibility = transferData.eligibility || {};
    const reviewCount = transferData.counts.promote + transferData.counts["move-down"];
    const strongestPromotion = transferData.recommendations.find((item) => item.category === "promote");
    const mostUrgentReview = transferData.recommendations.find((item) => item.category === "move-down");
    const headline = reviewCount
      ? `${reviewCount} members cross a transfer-review threshold, ${transferData.counts.watch} belong on a coaching watchlist, and ${transferData.counts.keep} currently look aligned with their tier.`
      : `No member currently crosses a transfer-review threshold; ${transferData.counts.watch} belong on a coaching watchlist and ${transferData.counts.keep} look aligned with their tier.`;
    const actionSummary = mostUrgentReview
      ? `Start with ${mostUrgentReview.name} in ${mostUrgentReview.clubName}, then review promotion opportunities${strongestPromotion ? ` such as ${strongestPromotion.name}` : ""}. Do not move anyone from this screen alone.`
      : strongestPromotion
        ? `Start with promotion cases such as ${strongestPromotion.name}. Confirm roster space, member preference, and officer context first.`
        : "Use the watchlist for coaching conversations and wait for more daily evidence before changing placement.";

    return <div>
      <ExplanationBox headline="A decision-support list—not an automatic transfer list" meaning={headline} action={actionSummary} color="#a78bfa" />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(160px,1fr))", gap: 9, marginBottom: 14 }}>
        <MetricCard label="Promotion reviews" value={transferData.counts.promote} sub="Pace supports a higher quota" color="#34d399" />
        <MetricCard label="Lower-tier reviews" value={transferData.counts["move-down"]} sub="Current quota appears mismatched" color="#f87171" />
        <MetricCard label="Watch and coach" value={transferData.counts.watch} sub="Talk first; collect more evidence" color="#fbbf24" />
        <MetricCard label="Current tier suitable" value={transferData.counts.keep} sub="No move suggested now" color="#60a5fa" />
      </div>
      <div style={{ ...PANEL, marginBottom: 14, borderColor: "#2dd4bf44", background: "rgba(13,45,48,0.24)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "center", marginBottom: 8 }}>
          <div><div style={{ color: "#5eead4", fontSize: 11, fontWeight: 900 }}>Who this analysis includes</div><div style={{ color: "#d5d2e5", fontSize: 12, fontWeight: 800, marginTop: 3 }}>{eligibility.eligibleMembers ?? transferData.recommendations.length} of {eligibility.activeRosterMembers ?? transferData.recommendations.length} current roster members had enough current-club history through Day {analysisDay} to evaluate fairly.</div></div>
          <Badge color="#2dd4bf">Current-month records only</Badge>
        </div>
        <div style={{ color: "#9ca3af", fontSize: 10, lineHeight: 1.6 }}>Excluded automatically: <b style={{ color: "#c7c4dd" }}>{eligibility.excludedInactive || 0}</b> profiles no longer on that club’s current roster, <b style={{ color: "#c7c4dd" }}>{eligibility.excludedNoCurrentMonthHistory || 0}</b> current-roster profiles with no history for that club this month, and <b style={{ color: "#c7c4dd" }}>{eligibility.excludedPartialMonth || 0}</b> late or partial-month records. This prevents end-of-month transfers from being mistaken for poor performance.</div>
      </div>
      <div style={{ ...PANEL, marginBottom: 14 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "flex-end", marginBottom: 14 }}>
          <div><div style={{ color: "#e2e0f0", fontSize: 15, fontWeight: 900 }}>Member Transfer Helper</div><div style={MUTED}>Uses projected individual pace, the quota for the member’s current tier, recent direction, idle days, and up to three prior archived months. Analysis is through Day {analysisDay}.</div></div>
          <select value={clubFilter} onChange={(event) => setClubFilter(event.target.value)} style={{ background: "#0c0b18", border: "1px solid #2a2540", color: "#e2e0f0", borderRadius: 8, padding: "7px 9px", fontSize: 10 }}><option value="all">All clubs</option>{snapshots.map((snapshot) => <option key={snapshot.clubId} value={snapshot.clubId}>{snapshot.clubName}</option>)}</select>
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>{[["transfer-review", "Transfer reviews"], ["promote", "Promotion"], ["move-down", "Lower tier"], ["watch", "Watch & coach"], ["keep", "Keep"], ["all", "All evaluated members"]].map(([key, label]) => <button key={key} onClick={() => setCategoryFilter(key)} style={{ background: categoryFilter === key ? "#7c3aed" : "#17152a", border: `1px solid ${categoryFilter === key ? "#8b5cf6" : "#2a2540"}`, color: categoryFilter === key ? "#fff" : "#9ca3af", borderRadius: 8, padding: "6px 9px", fontSize: 9, fontWeight: 800, cursor: "pointer" }}>{label}</button>)}</div>
      </div>
      {!visible.length ? <EmptyState title="No members match this filter" detail="Try another recommendation category or club. A blank result means no member crossed that review threshold." /> : <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(300px,1fr))", gap: 10 }} className="insights-transfer-grid">{visible.map((item) => {
        const meta = CATEGORY[item.category];
        const suggestion = item.category === "keep" || item.category === "watch" ? item.currentTier : item.suggestedTier;
        return <div key={`${item.clubId}-${item.viewerId}`} style={{ ...PANEL, borderColor: `${meta.color}44`, padding: "14px 15px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "flex-start", marginBottom: 11 }}><div><div style={{ color: "#e2e0f0", fontSize: 13, fontWeight: 900 }}>{item.name}</div><div style={{ color: "#6b7280", fontSize: 9, marginTop: 2 }}>{item.clubName} · current tier {item.currentTier}</div></div><Badge color={meta.color}>{meta.icon} {meta.label}</Badge></div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 7, marginBottom: 11 }}>
            <div><div style={{ color: "#4b5563", fontSize: 8, textTransform: "uppercase", fontWeight: 800 }}>Projected finish</div><div style={{ color: meta.color, fontSize: 12, fontWeight: 900 }}>{fmt(item.projected)}</div><div style={{ color: "#6b7280", fontSize: 8 }}>{pct(item.projectedRatio, 0)} of quota</div></div>
            <div><div style={{ color: "#4b5563", fontSize: 8, textTransform: "uppercase", fontWeight: 800 }}>Recent direction</div><div style={{ color: item.trend === "rising" ? "#34d399" : item.trend === "falling" ? "#f87171" : "#c7c4dd", fontSize: 12, fontWeight: 900, textTransform: "capitalize" }}>{item.trend}</div><div style={{ color: "#6b7280", fontSize: 8 }}>{item.idleDays} recent idle day{item.idleDays === 1 ? "" : "s"}</div></div>
            <div><div style={{ color: "#4b5563", fontSize: 8, textTransform: "uppercase", fontWeight: 800 }}>Suggested placement</div><div style={{ color: "#c4b5fd", fontSize: 12, fontWeight: 900 }}>{suggestion}</div><div style={{ color: "#6b7280", fontSize: 8 }}>{item.confidence}</div></div>
          </div>
          <div style={{ background: "#0c0b18", borderRadius: 9, padding: "9px 10px", marginBottom: 8 }}><div style={{ color: "#8f88b8", fontSize: 8, fontWeight: 900, textTransform: "uppercase", marginBottom: 3 }}>Why it was flagged</div><div style={{ color: "#b9b5cf", fontSize: 10, lineHeight: 1.5 }}>{item.commentary}</div></div>
          <div style={{ borderLeft: `3px solid ${meta.color}`, paddingLeft: 9 }}><div style={{ color: meta.color, fontSize: 8, fontWeight: 900, textTransform: "uppercase", marginBottom: 2 }}>Recommended next step</div><div style={{ color: "#d5d2e5", fontSize: 10, lineHeight: 1.5 }}>{item.action}</div></div>
        </div>;
      })}</div>}
      {filtered.length > visibleCount && <div style={{ display: "flex", justifyContent: "center", marginTop: 12 }}><button onClick={() => setVisibleCount((count) => count + 12)} style={{ background: "#17152a", border: "1px solid #7c3aed66", color: "#c4b5fd", borderRadius: 9, padding: "8px 12px", fontSize: 10, fontWeight: 900, cursor: "pointer" }}>Show {Math.min(12, filtered.length - visibleCount)} more</button></div>}
      <div style={{ ...PANEL, marginTop: 14, borderColor: "#fbbf2444" }}><div style={{ color: "#fbbf24", fontSize: 10, fontWeight: 900, marginBottom: 5 }}>Human context still matters</div><div style={MUTED}>Availability, planned absences, new-member ramp-up, player preference, officer judgment, and roster capacity are not present in the JSON. Treat “promotion” and “lower-tier” as review prompts, never automatic decisions.</div></div>
    </div>;
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
        comfortablyAbove: forecasts.filter((entry) => entry.forecast.low >= entry.snapshot.clubTarget).length,
        uncertain: forecasts.filter((entry) => entry.forecast.low < entry.snapshot.clubTarget && entry.forecast.high >= entry.snapshot.clubTarget).length,
        clearlyBelow: forecasts.filter((entry) => entry.forecast.high < entry.snapshot.clubTarget).length,
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
    const transferData = useMemo(() => A.buildTransferRecommendations(snapshots, historyByClub, analysisDay), [snapshots, historyByClub, analysisDay]);

    const sections = [
      ["forecast", "📡 Forecasts"],
      ["momentum", "⚡ Momentum & Resilience"],
      ["twins", "🪞 Historical Twins"],
      ["profiles", "🧬 Member Archetypes"],
      ["transfer", "🔄 Transfer Helper"],
    ];
    const sliderStops = [5, 10, 15, 20, 25, latestDay].filter((day, index, values) => day <= latestDay && values.indexOf(day) === index);
    const selectedClub = clubs.find((club) => String(club.id) === String(selectedClubId));
    const overallGap = overall.forecast - overall.target;
    const selectedForecastGap = selectedSnapshot && selectedForecast ? selectedForecast.forecast - selectedSnapshot.clubTarget : null;
    const selectedForecastMeaning = selectedSnapshot && selectedForecast
      ? selectedForecast.high < selectedSnapshot.clubTarget
        ? `${selectedSnapshot.clubName}'s entire working range is below its goal, so this is one of the clearest clubs to prioritize.`
        : selectedForecast.low >= selectedSnapshot.clubTarget
          ? `${selectedSnapshot.clubName}'s entire working range is above its goal, giving it a comparatively comfortable outlook.`
          : `${selectedSnapshot.clubName}'s goal falls inside the working range, so the outcome is still genuinely uncertain.`
      : "Select a club to see its interpretation.";

    if (!A) return <EmptyState title="Insights analytics failed to load" detail="Reload the page. The Chronogenesis data has not been modified." />;
    if (!snapshots.length) return <EmptyState title="Waiting for Chronogenesis data" detail="No current club JSON was available to analyze. Dominarium will remain unavailable until its external feed creates a JSON file." />;

    return (
      <div>
        <div style={{ ...PANEL, marginBottom: 14, background: "linear-gradient(135deg, rgba(124,58,237,0.16), rgba(17,16,40,0.94) 48%, rgba(37,99,235,0.10))" }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 16, alignItems: "flex-start", flexWrap: "wrap" }}>
            <div style={{ maxWidth: 760 }}><div style={{ color: "#f1eefc", fontSize: 25, fontWeight: 900 }}>Deeper Insights</div><div style={{ color: "#8f88b8", fontSize: 12, lineHeight: 1.65, marginTop: 5 }}>Use these five views to answer practical questions: where clubs may finish, what changed recently, which past months look similar, how members contribute, and which placements deserve a human review. Every view now includes a plain-language interpretation.</div></div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}><Badge color="#a78bfa">{monthLabel(monthKey || snapshots[0]?.monthKey)}</Badge><Badge color={isArchiveView ? "#c4b5fd" : "#34d399"}>{isArchiveView ? "Past-month view" : "Current-month data"}</Badge><Badge color={historyStatus.loading ? "#fbbf24" : "#60a5fa"}>{historyStatus.loading ? `Loading prior months ${historyStatus.loaded + historyStatus.failed}/${historyStatus.total}` : `${historyStatus.loaded} prior months loaded`}</Badge></div>
          </div>
          <div style={{ marginTop: 16, display: "grid", gridTemplateColumns: "minmax(230px,1fr) auto", gap: 14, alignItems: "end" }} className="insights-day-control">
            <div><div style={{ display: "flex", justifyContent: "space-between", gap: 8, marginBottom: 7 }}><span style={{ color: "#c7c4dd", fontSize: 11, fontWeight: 800 }}>Analyze as of Day {analysisDay}</span><span style={{ color: "#6b7280", fontSize: 10 }}>Latest available: Day {latestDay}</span></div><input aria-label="Analysis day" type="range" min="1" max={latestDay} value={analysisDay} onChange={(event) => setAnalysisDay(Number(event.target.value))} style={{ width: "100%", accentColor: "#7c3aed" }} /></div>
            <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>{sliderStops.map((day) => <button key={day} onClick={() => setAnalysisDay(day)} style={{ background: analysisDay === day ? "#7c3aed" : "#17152a", border: `1px solid ${analysisDay === day ? "#8b5cf6" : "#2a2540"}`, color: "#e2e0f0", borderRadius: 8, padding: "6px 8px", fontSize: 9, fontWeight: 800, cursor: "pointer" }}>Day {day}</button>)}</div>
          </div>
          {latestDay >= dim && analysisDay >= dim && <div style={{ marginTop: 10, color: "#fbbf24", fontSize: 10 }}>This month is complete, so the table shows actual month-end results. Move the day slider backward to replay and test the forecast without future-day leakage.</div>}
        </div>

        <div style={{ display: "flex", gap: 7, flexWrap: "wrap", marginBottom: 14 }}>{sections.map(([key, label]) => <button key={key} onClick={() => setActiveSection(key)} style={{ background: activeSection === key ? "#7c3aed" : "#111028", border: `1px solid ${activeSection === key ? "#8b5cf6" : "#1e1b35"}`, color: activeSection === key ? "#fff" : "#9ca3af", borderRadius: 9, padding: "8px 11px", fontSize: 10, fontWeight: 800, cursor: "pointer" }}>{label}</button>)}</div>

        {activeSection === "forecast" && <>
          <ExplanationBox
            headline={overallGap >= 0 ? `The network midpoint is ${fmt(overallGap)} above the combined goal.` : `The network midpoint is ${fmt(Math.abs(overallGap))} below the combined goal.`}
            meaning={`${overall.comfortablyAbove} clubs have a working range entirely above goal, ${overall.uncertain} could finish on either side, and ${overall.clearlyBelow} have a range entirely below goal.`}
            action={overall.clearlyBelow ? "Start with the red clubs whose full range remains below 100%, then review yellow clubs where relatively small changes could alter the result." : "No club has a full range below goal right now. Watch the yellow clubs because their outcome can still move either way."}
            color={overallGap >= 0 ? "#34d399" : "#f87171"}
          />
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(175px,1fr))", gap: 10, marginBottom: 14 }}>
            <MetricCard label="Fans earned so far" value={fmt(overall.current)} sub={`${overall.clubCount}/${clubs.length} clubs currently have data`} />
            <MetricCard label="Best network estimate" value={fmt(overall.forecast)} sub={`${fmt(overall.low)} – ${fmt(overall.high)} working range`} color="#c4b5fd" />
            <MetricCard label="Combined network goal" value={fmt(overall.target)} sub="Each club's member quota × active roster" color="#60a5fa" />
            <MetricCard label="Clubs above goal at midpoint" value={`${overall.aboveTarget}/${overall.clubCount}`} sub="A planning estimate, not a guarantee" color="#34d399" />
          </div>
          <TargetAttainmentDotPlot clubs={clubs} snapshotsById={snapshotsById} forecastsById={forecastsById} selectedClubId={selectedClubId} setSelectedClubId={setSelectedClubId} analysisDay={analysisDay} />
          <ForecastTable clubs={clubs} snapshotsById={snapshotsById} forecastsById={forecastsById} selectedClubId={selectedClubId} setSelectedClubId={setSelectedClubId} />
          {selectedSnapshot && selectedForecast && <div style={{ ...PANEL, marginTop: 14 }}><div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}><div><div style={{ color: "#e2e0f0", fontWeight: 800, fontSize: 13 }}>{selectedSnapshot.clubName}: what the forecast says</div><div style={{ color: selectedForecastGap >= 0 ? "#34d399" : "#f87171", fontWeight: 800, fontSize: 11, marginTop: 5 }}>{selectedForecastGap >= 0 ? `${fmt(selectedForecastGap)} above goal at the midpoint` : `${fmt(Math.abs(selectedForecastGap))} below goal at the midpoint`}</div></div><Badge color={selectedForecast.confidenceColor}>{selectedForecast.confidence} confidence</Badge></div><div style={{ color: "#c7c4dd", fontSize: 11, lineHeight: 1.55, marginTop: 9 }}>{selectedForecastMeaning}</div><div style={{ ...MUTED, marginTop: 8 }}>The club goal is {fmt(selectedSnapshot.perMemberTarget)} per active member × {selectedSnapshot.activeMemberCount} members = {fmt(selectedSnapshot.clubTarget)}. “{selectedForecast.confidence} confidence” describes how much comparable history is available, not the probability of success. Global rank remains less certain because outside clubs are not visible.</div></div>}
        </>}

        {activeSection === "momentum" && <>
          <ExplanationBox
            headline={clubMomentumAlerts.length ? `${clubMomentumAlerts.length} clubs show a coordinated change large enough to affect their goal.` : "No club-wide momentum shift is large enough to flag right now."}
            meaning={networkMemberAlerts.length ? `${networkMemberAlerts.length} individual members also changed sharply enough that their remaining-month effect could matter.` : "Small or isolated daily changes are intentionally hidden so normal noise does not create false alarms."}
            action={clubMomentumAlerts.length || networkMemberAlerts.length ? "Review the named members for planned absences, events, or temporary spikes before changing a target or placement." : "No immediate action is suggested. Continue watching daily updates rather than reacting to small swings."}
            color={clubMomentumAlerts.length || networkMemberAlerts.length ? "#fbbf24" : "#34d399"}
          />
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(210px,1fr))", gap: 10, marginBottom: 14 }}>
            <MetricCard label="Material club shifts" value={clubMomentumAlerts.length} sub="Requires several members moving together" color={clubMomentumAlerts.length ? "#fbbf24" : "#34d399"} />
            <MetricCard label="Large member variances" value={networkMemberAlerts.length} sub="Filtered for both relative size and target impact" color={networkMemberAlerts.length ? "#f97316" : "#34d399"} />
            <MetricCard label="Selected club" value={selectedClub?.name || selectedSnapshot?.clubName || "—"} sub={`Analysis through Day ${analysisDay}`} color="#c4b5fd" />
          </div>
          <div style={{ ...PANEL, marginBottom: 14 }}><div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 12 }}><div><div style={{ color: "#e2e0f0", fontSize: 14, fontWeight: 800 }}>Only changes large enough to matter</div><div style={MUTED}>This list hides ordinary day-to-day variation and surfaces only sharp changes with enough volume to affect the club’s monthly goal.</div></div><select value={selectedClubId} onChange={(event) => setSelectedClubId(event.target.value)} style={{ background: "#0c0b18", border: "1px solid #2a2540", color: "#e2e0f0", borderRadius: 8, padding: "7px 9px", fontSize: 10 }}>{snapshots.map((snapshot) => <option key={snapshot.clubId} value={snapshot.clubId}>{snapshot.clubName}</option>)}</select></div>
            {!selectedMomentum?.ready ? <div style={MUTED}>{selectedMomentum?.reason || "No momentum data."}</div> : selectedMomentum.memberAlerts.length ? <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>{selectedMomentum.clubAlert && <div style={{ border: `1px solid ${selectedMomentum.clubAlert.direction === "up" ? "#34d39955" : "#f8717155"}`, background: selectedMomentum.clubAlert.direction === "up" ? "#34d39912" : "#f8717112", borderRadius: 10, padding: "10px 12px", color: selectedMomentum.clubAlert.direction === "up" ? "#34d399" : "#f87171", fontSize: 11, fontWeight: 800 }}>Club-level {selectedMomentum.clubAlert.direction === "up" ? "acceleration" : "slowdown"}: {selectedMomentum.clubAlert.affectedMembers} members are moving together with an estimated {fmt(selectedMomentum.clubAlert.combinedImpact)} remaining-month target impact.</div>}{selectedMomentum.memberAlerts.slice(0, 10).map((alert) => <div key={alert.viewerId} style={{ display: "grid", gridTemplateColumns: "minmax(130px,1fr) auto auto auto", gap: 12, alignItems: "center", borderBottom: "1px solid #1e1b35", padding: "8px 2px", fontSize: 10 }}><div style={{ color: "#e2e0f0", fontWeight: 800 }}>{alert.name}</div><div style={{ color: "#6b7280" }}>Baseline <b style={{ color: "#9ca3af" }}>{fmt(alert.baselineAverage)}/day</b></div><div style={{ color: "#6b7280" }}>Recent <b style={{ color: alert.direction === "up" ? "#34d399" : "#f87171" }}>{fmt(alert.recentAverage)}/day</b></div><div style={{ color: alert.direction === "up" ? "#34d399" : "#f87171", fontWeight: 800 }}>{Number.isFinite(alert.relativeChange) ? `${alert.relativeChange >= 0 ? "+" : ""}${Math.round(alert.relativeChange * 100)}%` : "New activity"}</div></div>)}</div> : <div style={MUTED}>No member variance is large and material enough to surface for this club and day.</div>}
          </div>
          <div style={{ ...PANEL }}><div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap", marginBottom: 14 }}><div><div style={{ color: "#e2e0f0", fontSize: 14, fontWeight: 800 }}>Monthly Contribution Pie — {selectedSnapshot?.clubName}</div><div style={MUTED}>Each player’s cumulative gain divided by total club gain as of Day {analysisDay}. Departed or unmatched contribution is retained as “Other / roster changes.”</div></div>{resilience?.sustainedConcentration ? <Badge color="#f87171">Concentration risk</Badge> : <Badge color="#34d399">No sustained warning</Badge>}</div>
            {resilience && <><div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(145px,1fr))", gap: 8, marginBottom: 14 }}><MetricCard label="Largest player share" value={pct(resilience.topOneShare)} sub="How much comes from the #1 contributor" /><MetricCard label="Top 3 combined share" value={pct(resilience.topThreeShare)} sub="Dependence on the three largest contributors" /><MetricCard label="Top 5 combined share" value={pct(resilience.topFiveShare)} sub={`${resilience.concentrationChange >= 0 ? "+" : ""}${(resilience.concentrationChange * 100).toFixed(1)} points vs Day ${Math.max(1, analysisDay - 7)}`} color={resilience.sustainedConcentration ? "#f87171" : "#fbbf24"} /><MetricCard label="Equivalent contributor count" value={resilience.effectiveContributors.toFixed(1)} sub="Higher means gains are spread more broadly" color="#60a5fa" /></div><ExplanationBox headline={resilience.sustainedConcentration ? "This club is unusually dependent on a small group." : "No sustained concentration warning is active."} meaning={`The top five players provide ${pct(resilience.topFiveShare)} of the club's gain. The equivalent contributor count of ${resilience.effectiveContributors.toFixed(1)} estimates how many equally-sized contributors would create the same spread.`} action={resilience.sustainedConcentration ? "Build backup capacity and watch whether the same few members remain dominant. A planned absence from one of them could materially change the club result." : "No resilience action is required from this measure alone. Continue monitoring if the top-five share rises over several updates."} color={resilience.sustainedConcentration ? "#f87171" : "#34d399"} /></>}
            {resilience?.alert && <div style={{ color: "#f87171", background: "#f8717110", border: "1px solid #f8717144", borderRadius: 9, padding: "9px 11px", fontSize: 10, fontWeight: 700, marginBottom: 16 }}>{resilience.alert}</div>}
            <ContributionDonut resilience={resilience} expanded={contributionExpanded} setExpanded={setContributionExpanded} />
          </div>
        </>}

        {activeSection === "twins" && <>
          <ExplanationBox headline="Historical twins answer: ‘When this club looked like this before, how did the month finish?’" meaning="Similarity compares the shape of the selected club’s progress with its own earlier months after adjusting for the fan target active in each month." action="Use the closest match as context for planning—not as a promise. Pay most attention when several prior months point in the same direction." color="#a78bfa" />
          <div style={PANEL}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 14 }}><div><div style={{ color: "#e2e0f0", fontSize: 14, fontWeight: 800 }}>Club-level Historical Twins</div><div style={MUTED}>Compares the selected club’s target-normalized trajectory through Day {analysisDay} with up to three earlier completed months for the same club.</div></div><select value={selectedClubId} onChange={(event) => setSelectedClubId(event.target.value)} style={{ background: "#0c0b18", border: "1px solid #2a2540", color: "#e2e0f0", borderRadius: 8, padding: "7px 9px", fontSize: 10 }}>{snapshots.map((snapshot) => <option key={snapshot.clubId} value={snapshot.clubId}>{snapshot.clubName}</option>)}</select></div>
          {historyStatus.loading && !twins.length ? <div style={MUTED}>Loading the latest historical snapshots for this club…</div> : twins.length ? <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))", gap: 10 }}>{twins.map((twin, index) => <div key={twin.monthKey} style={{ background: "#0c0b18", border: `1px solid ${index === 0 ? "#7c3aed88" : "#1e1b35"}`, borderRadius: 12, padding: "14px 15px" }}><div style={{ display: "flex", justifyContent: "space-between", gap: 8, marginBottom: 10 }}><div style={{ color: "#e2e0f0", fontWeight: 800 }}>{monthLabel(twin.monthKey)}</div><Badge color={index === 0 ? "#a78bfa" : "#60a5fa"}>{twin.similarity}% similar</Badge></div><div style={{ color: twin.finalProgress >= 1 ? "#34d399" : "#fbbf24", background: twin.finalProgress >= 1 ? "#34d39910" : "#fbbf2410", borderRadius: 8, padding: "7px 9px", fontSize: 10, fontWeight: 800, marginBottom: 10 }}>What happened next: finished {twin.finalProgress >= 1 ? `${pct(twin.finalProgress - 1)} above` : `${pct(1 - twin.finalProgress)} below`} that month’s goal.</div><div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, fontSize: 10 }}><div><div style={{ color: "#4b5563" }}>Progress by Day {analysisDay}</div><div style={{ color: "#c4b5fd", fontWeight: 800 }}>{pct(twin.progressAtDay)}</div></div><div><div style={{ color: "#4b5563" }}>Final goal attainment</div><div style={{ color: twin.finalProgress >= 1 ? "#34d399" : "#fbbf24", fontWeight: 800 }}>{pct(twin.finalProgress)}</div></div><div><div style={{ color: "#4b5563" }}>Final club gain</div><div style={{ color: "#e2e0f0", fontWeight: 800 }}>{fmt(twin.finalGain)}</div></div><div><div style={{ color: "#4b5563" }}>Global rank movement</div><div style={{ color: "#e2e0f0", fontWeight: 800 }}>{twin.rankAtDay && twin.finalRank ? `#${twin.rankAtDay.toLocaleString()} → #${twin.finalRank.toLocaleString()}` : "Unavailable"}</div></div></div><div style={{ ...MUTED, marginTop: 10 }}>Historical quota: {fmt(twin.perMemberTarget)}/member · {twin.activeMemberCount} active in archived roster</div></div>)}</div> : <EmptyState title="No valid historical twin yet" detail="This club needs an earlier completed archive with a captured target and enough daily history. Dominarium currently has no history, while some clubs have only one usable month." />}
          </div>
        </>}

        {activeSection === "profiles" && <>
          <ExplanationBox headline="Archetypes describe how someone contributes—not whether they are good or bad." meaning="Each active member receives one primary pattern based on daily consistency, timing, concentration, target progress, and recent direction." action="Use the pattern to tailor expectations: protect consistency, plan around weekend-focused members, and avoid judging burst contributors from one quiet day." color="#2dd4bf" />
          <div style={PANEL}>
            <div style={{ marginBottom: 14 }}><div style={{ color: "#e2e0f0", fontSize: 14, fontWeight: 800 }}>Network-wide Member Archetypes</div><div style={MUTED}>These descriptions summarize contribution style. They are not rankings, transfer decisions, or permanent labels.</div></div>
            {!profiles.ready ? <EmptyState title="Not enough elapsed data" detail={profiles.reason} /> : <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(230px,1fr))", gap: 10 }}>{profiles.groups.map((group) => { const showAll = Boolean(profileExpanded[group.key]); const visible = showAll ? group.members : group.members.slice(0, 6); return <div key={group.key} style={{ background: "#0c0b18", border: `1px solid ${group.color}44`, borderRadius: 12, padding: "13px 14px" }}><div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginBottom: 5 }}><div style={{ color: group.color, fontWeight: 800, fontSize: 12 }}>{group.label}</div><Badge color={group.color}>{group.members.length}</Badge></div><div style={{ ...MUTED, minHeight: 33, marginBottom: 9 }}>{PROFILE_DESCRIPTIONS[group.key]}</div><div style={{ display: "flex", flexDirection: "column", gap: 6 }}>{visible.map((member) => <div key={`${member.viewerId}-${member.clubName}`} style={{ display: "flex", justifyContent: "space-between", gap: 10, fontSize: 10 }}><div style={{ minWidth: 0 }}><div style={{ color: "#e2e0f0", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{member.name}</div><div style={{ color: "#4b5563", fontSize: 9 }}>{member.clubName}</div></div><div style={{ color: "#9ca3af", fontWeight: 700, whiteSpace: "nowrap" }}>{pct(member.progressRatio)} of quota</div></div>)}</div>{group.members.length > 6 && <button onClick={() => setProfileExpanded((previous) => ({ ...previous, [group.key]: !showAll }))} style={{ marginTop: 10, background: "transparent", border: 0, color: group.color, fontSize: 9, fontWeight: 800, cursor: "pointer", padding: 0 }}>{showAll ? "Show fewer" : `Show ${group.members.length - 6} more`}</button>}</div>; })}</div>}
          </div>
        </>}

        {activeSection === "transfer" && <TransferHelper transferData={transferData} snapshots={snapshots} analysisDay={analysisDay} />}

        <div style={{ ...PANEL, marginTop: 14, borderColor: "#3a3159" }}><div style={{ color: "#c4b5fd", fontSize: 11, fontWeight: 800, marginBottom: 6 }}>Known limits—in plain language</div><div style={MUTED}>The site loads up to three earlier months per club, and some clubs have little or no history. Historical rosters are month-end snapshots rather than a day-by-day record. Outside clubs are invisible, which makes rank estimates weaker than fan forecasts. Transfer guidance cannot see absences, personal preference, roster capacity, or officer context. Treat every range and recommendation as decision support, not an automatic answer. No Chronogenesis file or job is changed by this page.</div></div>
      </div>
    );
  }

  window.DeeperInsightsPage = DeeperInsightsPage;
})();
