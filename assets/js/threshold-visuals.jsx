(function () {
  const { useState, useRef, useEffect } = React;
  const num = v => v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v);
  const fmt = v => v == null ? '—' : Math.abs(v) >= 1e9 ? (v / 1e9).toFixed(2) + 'B' : Math.abs(v) >= 1e6 ? (v / 1e6).toFixed(1) + 'M' : Math.abs(v) >= 1e3 ? (v / 1e3).toFixed(1) + 'K' : Math.round(v).toLocaleString();
  const last = a => a[a.length - 1];
  function observations(feed, month, day) {
    if (!feed?.currentMonthActive || feed.month !== month) return [];
    const byDay = new Map();
    for (const s of feed.days || []) {
      const d = num(s?.day);
      if (Number.isInteger(d) && d >= Math.max(1, num(feed.activationDay) || 1) && d <= day && Array.isArray(s.thresholds)) byDay.set(d, { ...s, day: d });
    }
    return [...byDay.values()].sort((a, b) => a.day - b.day);
  }
  function rankPoints(obs, name) {
    return obs.map(s => ({ day: s.day, value: num(s.thresholds.find(t => t.name === name)?.current_min_fans) })).filter(p => p.value != null && p.value >= 0);
  }
  function segments(points, forecast = false) {
    const groups = [];
    for (const p of points) {
      if (!groups.length || (!forecast && p.day !== last(last(groups)).day + 1)) groups.push([]);
      last(groups).push(p);
    }
    return groups;
  }
  function niceStep(max) {
    const rough = Math.max(1, max) / 4;
    const unit = Math.pow(10, Math.floor(Math.log10(rough)));
    return [1, 2, 2.5, 5, 10].find(v => v * unit >= rough) * unit;
  }
  function labelPositions(items, top, bottom, gap = 44) {
    const sorted = items.map(i => ({ ...i })).sort((a, b) => a.y - b.y);
    sorted.forEach((i, n) => { i.labelY = Math.max(i.y, n ? sorted[n - 1].labelY + gap : top); });
    if (sorted.length && last(sorted).labelY > bottom) {
      last(sorted).labelY = bottom;
      for (let n = sorted.length - 2; n >= 0; n--) sorted[n].labelY = Math.min(sorted[n].labelY, sorted[n + 1].labelY - gap);
    }
    return sorted;
  }
  function buildClubView(feed, data, club, month, today, dim) {
    const cutoff = Math.min(today, dim);
    const byDay = new Map();
    // Archive/current-month data must not be mixed.
    const matchingMonth = !data?.datasetMonthKey || data.datasetMonthKey === month;
    for (const r of matchingMonth ? data?.clubDailyHistory || [] : []) {
      const day = num(r.actual_date);
      if (Number.isInteger(day) && day >= 1 && day <= cutoff) byDay.set(day, r);
    }
    const history = [...byDay.entries()].sort((a, b) => a[0] - b[0]);
    const actual = history.map(([day, r]) => ({ day, value: num(r.interpolated_fan_count) })).filter(p => p.value != null && p.value >= 0);
    const ranked = [...history].reverse().find(([, r]) => num(r.rank) > 0);
    const rank = num(ranked?.[1].rank);
    const obs = observations(feed, month, cutoff);
    const tiers = (last(obs)?.thresholds || []).filter(r => num(r.ranking_from) != null).sort((a, b) => a.ranking_from - b.ranking_from);
    const index = rank > 0 ? tiers.findIndex(r => rank >= r.ranking_from && (r.ranking_to == null || rank <= r.ranking_to)) : -1;
    const tier = tiers[index], upper = index > 0 ? tiers[index - 1] : null, lower = tiers[index + 1];
    const series = [{ name: club.name, shortName: 'Your club', color: '#ffa5af', kind: 'primary', points: actual }];
    if (upper) series.push({ name: 'Reach ' + upper.name, shortName: 'Reach ' + upper.name, color: '#8cbcf2', kind: 'boundary', points: rankPoints(obs, upper.name) });
    if (tier) series.push({ name: 'Stay in ' + tier.name, shortName: 'Stay in ' + tier.name, color: '#e7bf78', kind: 'boundary', points: rankPoints(obs, tier.name) });
    // Compare the same recorded day, not a fresh club total with an older cutoff.
    const commonDay = tier ? [...actual].reverse().find(p => series.slice(1).every(s => s.points.some(q => q.day === p.day)))?.day : null;
    const common = commonDay != null ? {
      day: commonDay,
      gain: actual.find(p => p.day === commonDay).value,
      upper: upper ? series.find(s => s.name === 'Reach ' + upper.name)?.points.find(p => p.day === commonDay)?.value : null,
      floor: series.find(s => s.name === 'Stay in ' + tier.name)?.points.find(p => p.day === commonDay)?.value
    } : null;
    return { series, tier, upper, lower, rank, rankDay: ranked?.[0], latestGain: last(actual), common };
  }

  function FanChart({ series, title, dim, showForecast = false }) {
    const wrap = useRef(null);
    const [width, setWidth] = useState(900);
    const [selected, setSelected] = useState(null);
    const [tableOpen, setTableOpen] = useState(false);
    useEffect(() => {
      const node = wrap.current;
      if (!node) return;
      const measure = () => setWidth(Math.max(240, node.clientWidth));
      measure();
      if (typeof ResizeObserver === 'undefined') {
        window.addEventListener('resize', measure);
        return () => window.removeEventListener('resize', measure);
      }
      const observer = new ResizeObserver(measure);
      observer.observe(node);
      return () => observer.disconnect();
    }, []);
    const visible = series.filter(s => s.points.length && (s.kind !== 'forecast' || showForecast));
    const actualDays = [...new Set(visible.filter(s => s.kind !== 'forecast').flatMap(s => s.points.map(p => p.day)))].sort((a, b) => a - b);
    if (!actualDays.length) return <div className="fan-empty">No recorded daily values yet.</div>;
    const mobile = width < 660, height = mobile ? 284 : 320;
    const pad = { left: mobile ? 48 : 60, right: mobile ? 20 : 188, top: 30, bottom: 40 };
    const endDay = showForecast ? dim : last(actualDays);
    const startDay = Math.min(1, endDay - 1);
    const plotRight = width - pad.right, plotBottom = height - pad.bottom;
    const topValue = Math.max(1, ...visible.flatMap(s => s.points.map(p => p.value))) * 1.12;
    const step = niceStep(topValue);
    const gridSteps = Math.ceil(topValue / step);
    const ceiling = step * gridSteps;
    const x = d => pad.left + (d - startDay) / Math.max(1, endDay - startDay) * (plotRight - pad.left);
    const y = v => plotBottom - v / ceiling * (plotBottom - pad.top);
    const tickCount = mobile ? 3 : 6;
    const ticks = [...new Set(Array.from({ length: tickCount }, (_, i) => Math.max(1, Math.round(1 + i * (endDay - 1) / (tickCount - 1)))))];
    const labels = labelPositions(visible.map(s => ({ ...s, point: last(s.points), y: y(last(s.points).value) })), pad.top + 8, plotBottom - 12);
    const inspectDay = actualDays.includes(selected) ? selected : last(actualDays);
    const onPointer = event => {
      const bounds = event.currentTarget.getBoundingClientRect();
      const pointerX = (event.clientX - bounds.left) / bounds.width * width;
      const d = startDay + (pointerX - pad.left) / (plotRight - pad.left) * (endDay - startDay);
      setSelected(actualDays.reduce((best, candidate) => Math.abs(candidate - d) < Math.abs(best - d) ? candidate : best, actualDays[0]));
    };
    const onKey = event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const n = actualDays.indexOf(inspectDay);
      setSelected(event.key === 'Home' ? actualDays[0] : event.key === 'End' ? last(actualDays) : actualDays[Math.max(0, Math.min(actualDays.length - 1, n + (event.key === 'ArrowLeft' ? -1 : 1)))]);
    };
    const recorded = visible.filter(s => s.kind !== 'forecast');
    return <div className="fan-chart" ref={wrap}>
      <div className="fan-chart-meta"><span>Cumulative fans</span><span>{showForecast ? 'Recorded + modeled outlook' : 'Recorded days only'} · through Day {last(actualDays)}</span></div>
      <svg viewBox={'0 0 ' + width + ' ' + height} role="img" aria-label={title + '. Arrow keys inspect recorded days. Exact values are available below.'} tabIndex="0" onKeyDown={onKey} onPointerMove={onPointer} onPointerDown={onPointer} onPointerLeave={() => setSelected(null)}>
        <title>{title}</title>
        {showForecast && last(actualDays) < dim && <rect x={x(last(actualDays))} y={pad.top} width={plotRight - x(last(actualDays))} height={plotBottom - pad.top} fill="#e7bf78" opacity=".035" />}
        {Array.from({ length: gridSteps + 1 }, (_, n) => n).map(t => <g key={t}>
          <line x1={pad.left} x2={plotRight} y1={y(step * t)} y2={y(step * t)} className="fan-grid-line" />
          <text x={pad.left - 10} y={y(step * t) + 4} textAnchor="end" className="fan-axis">{fmt(step * t)}</text>
        </g>)}
        {ticks.map(d => <text key={d} x={x(d)} y={height - 12} textAnchor="middle" className="fan-axis">Day {d}</text>)}
        {visible.map(s => <g key={s.name}>
          {segments(s.points, s.kind === 'forecast').map((group, i) => {
            const path = group.map((p, n) => (n ? 'L ' : 'M ') + x(p.day) + ' ' + y(p.value)).join(' ');
            return <g key={i}>
              {s.kind === 'primary' && group.length > 1 && <path d={path + ' L ' + x(last(group).day) + ' ' + plotBottom + ' L ' + x(group[0].day) + ' ' + plotBottom + ' Z'} fill={s.color} opacity=".045" />}
              <path d={path} fill="none" stroke={s.color} strokeWidth={s.kind === 'primary' ? 3.5 : 1.8} strokeDasharray={s.kind === 'boundary' ? '7 6' : s.kind === 'forecast' ? '3 6' : undefined} strokeLinecap="round" strokeLinejoin="round" />
              {group.length === 1 && <circle cx={x(group[0].day)} cy={y(group[0].value)} r={s.kind === 'primary' ? 4.5 : 3.5} fill={s.color} />}
            </g>;
          })}
          <circle cx={x(last(s.points).day)} cy={y(last(s.points).value)} r={s.kind === 'primary' ? 5 : 3.5} fill={s.color} stroke="#1b151a" strokeWidth="2" />
        </g>)}
        {selected != null && <g>
          <line x1={x(inspectDay)} x2={x(inspectDay)} y1={pad.top} y2={plotBottom} stroke="#d8b9c6" opacity=".5" strokeDasharray="2 5" />
          {recorded.map(s => { const p = s.points.find(q => q.day === inspectDay); return p ? <circle key={s.name} cx={x(p.day)} cy={y(p.value)} r="5" fill={s.color} stroke="#1b151a" strokeWidth="2" /> : null; })}
        </g>}
        {!mobile && labels.map(s => <g key={s.name}>
          <path d={'M ' + (x(s.point.day) + 8) + ' ' + s.y + ' L ' + (plotRight + 10) + ' ' + s.y + ' L ' + (plotRight + 22) + ' ' + s.labelY} stroke={s.color} strokeWidth="1" opacity=".5" fill="none" />
          <text x={plotRight + 30} y={s.labelY - 4} className="fan-end-name" fill={s.color}>{s.shortName || s.name}</text>
          <text x={plotRight + 30} y={s.labelY + 14} className="fan-end-value">{fmt(s.point.value)} · D{s.point.day}</text>
        </g>)}
      </svg>
      {mobile && <div className="fan-mobile-labels">{visible.map(s => <span key={s.name}><i style={{ background: s.color }} /><b>{s.shortName || s.name}</b> {fmt(last(s.points).value)} <small>· D{last(s.points).day}</small></span>)}</div>}
      <div className="fan-inspection" aria-live="polite">
        <b>Day {inspectDay}</b>{recorded.map(s => <span key={s.name}><i style={{ background: s.color }} />{s.shortName || s.name} <strong>{fmt(s.points.find(p => p.day === inspectDay)?.value)}</strong></span>)}
      </div>
      <div className="fan-chart-tools"><span>Hover, tap, or use arrow keys to explore.</span><button type="button" onClick={() => setTableOpen(!tableOpen)} aria-expanded={tableOpen}>{tableOpen ? 'Hide daily values' : 'View daily values'}</button></div>
      {tableOpen && <div className="fan-scroll"><table className="fan-data-table"><caption>{title} — recorded fans</caption><thead><tr><th scope="col">Day</th>{recorded.map(s => <th key={s.name} scope="col">{s.name}</th>)}</tr></thead><tbody>{actualDays.map(d => <tr key={d}><th scope="row">{d}</th>{recorded.map(s => { const v = s.points.find(p => p.day === d)?.value; return <td key={s.name}>{v == null ? '—' : Math.round(v).toLocaleString()}</td>; })}</tr>)}</tbody></table></div>}
    </div>;
  }

  function Metric({ label, value, detail, tone }) {
    return <div className={'fan-metric' + (tone ? ' fan-tone-' + tone : '')}><span>{label}</span><strong>{value}</strong><small>{detail}</small></div>;
  }
  function ClubBoundaryChart({ feed, data, club, month, today, dim }) {
    const view = buildClubView(feed, data, club, month, today, dim);
    const { tier, upper, lower, rank, common, latestGain } = view;
    const toUpper = common?.upper != null ? common.upper - common.gain : null;
    const buffer = common?.floor != null ? common.gain - common.floor : null;
    return <section className="fan-panel fan-club-panel">
      <header className="fan-header"><div><div className="fan-eyebrow">Club rank race</div><h2>How {club.name} is pacing</h2><p>{tier ? 'Currently ' + tier.name + ' · #' + rank.toLocaleString() + ' on Day ' + view.rankDay + '. Your configured target tier is ' + club.tier + '.' : 'Your club’s recorded gains. Rank boundaries will appear when matching data is available.'}</p></div>{tier && <span className="fan-tier-pill">{tier.name}</span>}</header>
      <div className="fan-metrics">
        <Metric label="Club fans earned" value={fmt(latestGain?.value)} detail={latestGain ? 'Cumulative through Day ' + latestGain.day : 'Waiting for club data'} />
        <Metric label={upper ? (toUpper != null && toUpper <= 0 ? 'Above the ' + upper.name + ' cutoff' : 'Fans to reach ' + upper.name) : tier ? 'Highest published tier' : 'Next tier'} value={toUpper == null ? (tier && !upper ? tier.name : '—') : fmt(Math.abs(toUpper))} detail={common && upper ? 'Compared on Day ' + common.day : tier && !upper ? 'No higher boundary is published' : 'Waiting for same-day values'} tone={toUpper != null && toUpper <= 0 ? 'good' : 'promotion'} />
        <Metric label={tier ? (buffer != null && buffer < 0 ? 'Below the ' + tier.name + ' cutoff' : 'Buffer to stay in ' + tier.name) : 'Lower boundary'} value={buffer == null ? '—' : fmt(Math.abs(buffer))} detail={common ? 'Day ' + common.day + (lower ? ' · below this line is ' + lower.name : '') : 'Waiting for same-day values'} tone={buffer != null && buffer < 0 ? 'risk' : 'buffer'} />
      </div>
      <FanChart key={club.id + '-' + month} series={view.series} title={club.name + ': cumulative fans and rank cutoffs'} dim={dim} />
      <p className="fan-footnote">Solid coral = your club. Dashed lines = recorded rank cutoffs, not forecasts or member quotas. Missing days stay blank. Rank positions and cutoff snapshots can update at different times; matching a cutoff does not guarantee a rank change.</p>
    </section>;
  }
  function ThresholdTrends({ feed, model, month, today, dim }) {
    const [outlook, setOutlook] = useState(false);
    const obs = observations(feed, month, Math.min(today, dim));
    const latest = last(obs);
    const rows = (latest?.thresholds || []).filter(r => num(r.current_min_fans) != null && num(r.ranking_to) != null).sort((a, b) => a.ranking_from - b.ranking_from);
    const canForecast = Boolean(model?.ready && obs.length >= 3);
    const showForecast = outlook && canForecast;
    const priorDate = new Date(Date.UTC(Number(month?.slice(0, 4)), Number(month?.slice(5, 7)) - 2, 1));
    const priorMonth = Number.isFinite(priorDate.getTime()) ? priorDate.toISOString().slice(0, 7) : 'Prior month';
    return <section className="fan-threshold-section">
      <header className="fan-header fan-section-header"><div><div className="fan-eyebrow">Rank thresholds</div><h2>What it takes to reach each tier</h2><p>Each chart tracks the fans earned by the club at that tier’s last qualifying rank. A higher cutoff means more fans are needed to stay competitive.</p></div><div className="fan-segmented" aria-label="Threshold chart time range"><button type="button" aria-pressed={!showForecast} onClick={() => setOutlook(false)}>Recorded days</button><button type="button" aria-pressed={showForecast} disabled={!canForecast} onClick={() => setOutlook(true)}>Month-end outlook</button></div></header>
      {!rows.length ? <div className="fan-panel fan-empty">Waiting for current-month rank thresholds. Previous-month totals are not shown as new daily gains.</div> : <>
        <p className="fan-section-note">{month} · {obs.length} recorded {obs.length === 1 ? 'day' : 'days'} · latest Day {latest.day}. {!canForecast ? 'Month-end outlook is collecting data; it needs at least three valid daily captures and a ready forecast.' : showForecast ? 'Dotted gold paths show a modeled outlook, not official future results.' : 'Showing recorded days only. Switch to month-end outlook to include modeled paths.'}</p>
        <nav className="fan-rank-jump" aria-label="Jump to a rank chart"><span>Jump to tier</span>{rows.map(r => <a key={r.name} href={'#rank-cutoff-' + r.rank_index}>{r.name}</a>)}</nav>
        <div className="fan-rank-grid">{rows.map(r => {
          const pts = rankPoints(obs, r.name), current = last(pts), previous = pts[pts.length - 2];
          const prediction = canForecast ? num(model.rows?.find(t => t.name === r.name)?.projectedMinFans) : null;
          const movement = current && previous ? current.value - previous.value : null;
          const series = [{ name: r.name + ' cutoff', shortName: r.name + ' cutoff', color: '#ffa5af', kind: 'primary', points: pts }];
          if (prediction != null && current && current.day < dim) series.push({ name: 'Modeled month end', shortName: 'Month-end model', color: '#e7bf78', kind: 'forecast', points: [current, { day: dim, value: prediction }] });
          return <article className="fan-panel fan-rank-panel" id={'rank-cutoff-' + r.rank_index} key={r.name}>
            <header className="fan-rank-header"><div className="fan-rank-identity"><span className="fan-rank-badge">{r.name}</span><div><h3>Top {Number(r.ranking_to).toLocaleString()} cutoff</h3><p>The entry line for {r.name}{r.ranking_from > 1 ? ' · ranks ' + Number(r.ranking_from).toLocaleString() + '–' + Number(r.ranking_to).toLocaleString() : ''}</p></div></div><div className="fan-latest"><strong>{fmt(current?.value)}</strong><span>fans through Day {current?.day}</span></div></header>
            <FanChart key={r.name + '-' + month} series={series} title={r.name + ' rank cutoff movement'} dim={dim} showForecast={showForecast} />
            <div className="fan-rank-context"><div><span>{previous ? 'Change since Day ' + previous.day : 'Change since previous capture'}</span><b>{movement == null ? 'Need another capture' : (movement >= 0 ? '+' : '−') + fmt(Math.abs(movement))}</b></div><div><span>{priorMonth} final cutoff</span><b>{fmt(num(r.last_month_min_fans))}</b></div><div><span>{month} modeled final cutoff</span><b>{prediction == null ? 'Collecting data' : fmt(prediction)}</b></div></div>
          </article>;
        })}</div>
        <section className="fan-panel"><header className="fan-header"><div><div className="fan-eyebrow">Month over month</div><h2>Is the competition getting tougher?</h2><p>Compare average fans needed per day across months of different lengths. Blue means a higher requirement; orange means lower. This month is an estimate, not a final result.</p></div></header>
          <div className="fan-scroll"><table className="fan-heatmap"><caption>Rank cutoff pace comparison, in fans per day</caption><thead><tr><th scope="col">Tier</th><th scope="col">{priorMonth}<small>Actual final / day</small></th><th scope="col">{month}<small>Modeled final / day</small></th><th scope="col">Change</th></tr></thead><tbody>{rows.map(r => {
            const prior = num(r.last_month_fans_per_day), prediction = canForecast ? num(model.rows?.find(t => t.name === r.name)?.projectedMinFans) : null;
            const rate = prediction == null ? null : prediction / dim, delta = prior > 0 && rate != null ? rate / prior - 1 : null;
            return <tr key={r.name}><th scope="row">{r.name}</th><td>{fmt(prior)}</td><td>{rate == null ? 'Collecting data' : fmt(rate)}</td><td className={delta == null || delta === 0 ? '' : delta > 0 ? 'fan-pace-higher' : 'fan-pace-lower'}>{delta == null ? '—' : (delta > 0 ? '+' : '') + (delta * 100).toFixed(1) + '%'}</td></tr>;
          })}</tbody></table></div><p className="fan-footnote">The feed currently provides the previous month’s final values and this month’s daily captures. Earlier monthly history is not invented.</p>
        </section>
      </>}
    </section>;
  }
  window.ThresholdTrends = ThresholdTrends;
  window.ClubBoundaryChart = ClubBoundaryChart;
  window.ThresholdVisualMath = { observations, rankPoints, segments, niceStep, labelPositions, buildClubView };
})();
