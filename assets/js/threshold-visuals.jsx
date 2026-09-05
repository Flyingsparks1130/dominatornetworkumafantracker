(function () {
  const num = v => v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v);
  const fmt = v => v == null ? '—' : Math.abs(v) >= 1e9 ? (v / 1e9).toFixed(2) + 'B' : (v / 1e6).toFixed(1) + 'M';
  function observations(feed, month, day) {
    if (!feed?.currentMonthActive || feed.month !== month) return [];
    return (feed.days || []).filter(s => s && s.day >= (feed.activationDay || 1) && s.day <= day && Array.isArray(s.thresholds)).sort((a,b) => a.day-b.day);
  }
  function Chart({ series, dim, label }) {
    const [selected, setSelected] = React.useState(null);
    const points = series.flatMap(s => s.points).filter(p => num(p.value) != null);
    const max = Math.max(1, ...points.map(p => p.value)) * 1.08;
    const x = d => 60 + (d - 1) / Math.max(1, dim - 1) * 640;
    const y = v => 210 - v / max * 175;
    const ticks = [...new Set([1, Math.ceil(dim / 2), dim])];
    return <div className="threshold-chart">
      <svg viewBox="0 0 730 250" role="img" aria-label={label}>
        {[0, .5, 1].map(t => <g key={t}><line x1="60" x2="700" y1={y(max*t)} y2={y(max*t)} stroke="#ffffff15"/><text x="52" y={y(max*t)+4} textAnchor="end" fill="#b6afba" fontSize="12">{fmt(max*t)}</text></g>)}
        {ticks.map(d => <text key={d} x={x(d)} y="235" textAnchor="middle" fill="#b6afba" fontSize="12">Day {d}</text>)}
        {series.map(s => <g key={s.name}>{s.points.map((p,i) => {
          const prev=s.points[i-1];
          return <g key={p.day}>{prev && (s.dashed || p.day === prev.day+1) && <line x1={x(prev.day)} x2={x(p.day)} y1={y(prev.value)} y2={y(p.value)} stroke={s.color} strokeWidth="2.5" strokeDasharray={s.dashed?'6 5':undefined}/>}
            <circle cx={x(p.day)} cy={y(p.value)} r="4" fill={s.color}><title>{s.name}: Day {p.day}, {Math.round(p.value).toLocaleString()} fans</title></circle></g>;
        })}</g>)}
        {selected && <line x1={x(selected)} x2={x(selected)} y1="28" y2="210" stroke="#ffffff55" strokeDasharray="3 4"/>}
      </svg>
      <div className="threshold-legend">{series.map(s => <span key={s.name}><i style={{background:s.color}}/>{s.name}{s.dashed?' (estimate)':''}</span>)}</div>
      <label className="threshold-day">Inspect day <input aria-label={label+' inspection day'} type="range" min="1" max={dim} value={selected || 1} onChange={e=>setSelected(Number(e.target.value))}/>{selected || '—'}</label>
      {selected && <div className="threshold-values">{series.map(s => <span key={s.name}>{s.name}: {fmt(s.points.find(p=>p.day===selected)?.value)}</span>)}</div>}
    </div>;
  }
  function ThresholdTrends({ feed, model, month, today, dim }) {
    const obs=observations(feed,month,today);
    const latest=obs[obs.length-1];
    const rows=(latest?.thresholds || []).filter(r=>num(r.current_min_fans)!=null && num(r.ranking_to)!=null).sort((a,b)=>a.ranking_from-b.ranking_from);
    return <section className="threshold-panel">
      <h2>Rank cutoff movement</h2><p>Cumulative fans needed at each tier boundary. Missing days are gaps, not zeros. Dashed lines are modeled month-end paths, not official future results.</p>
      {!rows.length ? <p>Waiting for current-month thresholds aligned to this game month.</p> : <>
        <div className="threshold-grid">{rows.map(r=> {
          const pts=obs.map(s=>({day:s.day,value:num(s.thresholds.find(t=>t.name===r.name)?.current_min_fans)})).filter(p=>p.value!=null);
          const prediction=model?.ready ? model.rows.find(t=>t.name===r.name)?.projectedMinFans : null;
          const last=pts[pts.length-1];
          const series=[{name:month+' actual',color:'#ff9c9f',points:pts}];
          if(prediction!=null && last.day<dim) series.push({name:'Forecast',color:'#fbbf24',dashed:true,points:[last,{day:dim,value:prediction}]});
          return <article key={r.name}><h3>{r.name} <small>rank {r.ranking_to.toLocaleString()}</small></h3><Chart series={series} dim={dim} label={r.name+' cutoff trend'}/><p>Prior month final: {fmt(num(r.last_month_min_fans))}</p></article>;
        })}</div>
        <h2>Month-over-month fan pace</h2><p>Blue means a higher daily requirement; orange means lower. Current-month comparison uses the forecast when ready. No earlier monthly history is present in the current feed.</p>
        <div className="threshold-scroll"><table className="threshold-heatmap"><thead><tr><th>Tier</th><th>Prior month actual / day</th><th>{month} forecast / day</th><th>Change</th></tr></thead><tbody>{rows.map(r=>{
          const prior=num(r.last_month_fans_per_day);
          const prediction=model?.ready ? num(model.rows.find(t=>t.name===r.name)?.projectedMinFans) : null;
          const rate=prediction==null?null:prediction/dim;
          const delta=prior>0 && rate!=null ? rate/prior-1 : null;
          return <tr key={r.name}><th>{r.name}</th><td>{fmt(prior)}</td><td>{rate==null?'Collecting data':fmt(rate)}</td><td style={{background:delta==null?'transparent':delta>=0?'#2563eb55':'#d9770655'}}>{delta==null?'—':(delta>=0?'+':'')+(delta*100).toFixed(1)+'%'}</td></tr>;
        })}</tbody></table></div>
      </>}
    </section>;
  }
  function ClubBoundaryChart({ feed, data, club, month, today, dim }) {
    const history=(data?.clubDailyHistory || []).filter(r=>r.actual_date<=today).sort((a,b)=>a.actual_date-b.actual_date);
    const actual=history.map(r=>({day:Number(r.actual_date),value:num(r.interpolated_fan_count)})).filter(p=>p.value!=null);
    const rank=num([...history].reverse().find(r=>num(r.rank)>0)?.rank);
    const obs=observations(feed,month,today);
    const tiers=(obs[obs.length-1]?.thresholds || []).filter(r=>num(r.ranking_from)!=null).sort((a,b)=>a.ranking_from-b.ranking_from);
    const index=rank>0 ? tiers.findIndex(r=>rank>=r.ranking_from && (r.ranking_to==null || rank<=r.ranking_to)) : -1;
    const tier=tiers[index], upper=index>0?tiers[index-1]:null, lower=tiers[index+1];
    const series=[{name:club.name,color:'#ff9c9f',points:actual}];
    for(const [t,name,color] of [[upper,upper?'Enter '+upper.name:'','#60a5fa'],[tier,tier?'Stay '+tier.name+(lower?' / fall to '+lower.name:''):'','#fbbf24']]) {
      if(t) series.push({name,color,points:obs.map(s=>({day:s.day,value:num(s.thresholds.find(r=>r.name===t.name)?.current_min_fans)})).filter(p=>p.value!=null)});
    }
    return <section className="threshold-panel" key={club.id}><h2>Club gain vs rank boundaries</h2><p>{tier?`Currently ${tier.name} · #${rank.toLocaleString()}. Configured tier: ${club.tier}. Boundaries follow the actual current rank.`:'Current rank boundaries are unavailable until aligned threshold and club data exist.'} {tier && !upper?'Already in the highest published tier.':''}</p><Chart series={series} dim={dim} label={club.name+' cumulative gain and rank boundaries'}/><p>Actual daily cumulative fans, not member quotas. Lines stop at the last observation; no future zero-fill or invented missing days.</p></section>;
  }
  window.ThresholdTrends=ThresholdTrends;
  window.ClubBoundaryChart=ClubBoundaryChart;
})();
