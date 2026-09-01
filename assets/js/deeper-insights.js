(function attachDominatorInsights(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.DominatorInsights = api;
})(typeof window !== "undefined" ? window : globalThis, function createDominatorInsights() {
  const number = (value, fallback = null) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  };

  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const sum = (values = []) => values.reduce((total, value) => total + (number(value, 0) || 0), 0);
  const average = (values = []) => values.length ? sum(values) / values.length : 0;
  const sortNumbers = (values = []) => values.map((value) => number(value)).filter((value) => value != null).sort((a, b) => a - b);
  const quantile = (values = [], q = 0.5) => {
    const sorted = sortNumbers(values);
    if (!sorted.length) return null;
    if (sorted.length === 1) return sorted[0];
    const position = clamp(q, 0, 1) * (sorted.length - 1);
    const lower = Math.floor(position);
    const upper = Math.ceil(position);
    const weight = position - lower;
    return sorted[lower] * (1 - weight) + sorted[upper] * weight;
  };
  const median = (values = []) => quantile(values, 0.5);
  const weightedAverage = (items = [], valueKey = "value", weightKey = "weight") => {
    const usable = items.filter((item) => number(item?.[valueKey]) != null && number(item?.[weightKey], 0) > 0);
    const totalWeight = sum(usable.map((item) => item[weightKey]));
    return totalWeight > 0 ? sum(usable.map((item) => item[valueKey] * item[weightKey])) / totalWeight : null;
  };

  const getDaysInMonth = (monthKey) => {
    const match = String(monthKey || "").match(/^(\d{4})-(\d{2})$/);
    if (!match) return 31;
    return new Date(Number(match[1]), Number(match[2]), 0).getDate();
  };

  const getMonthKeyFromJson = (json, fallback = "") => {
    const archiveMonth = json?._archive?.month;
    if (/^\d{4}-\d{2}$/.test(String(archiveMonth || ""))) return archiveMonth;
    const firstDate = Array.isArray(json?.month_filter) ? json.month_filter[0]?.sdate : null;
    const match = String(firstDate || "").match(/^(\d{4}-\d{2})-/);
    if (match) return match[1];
    return fallback;
  };

  const maxDayFromRows = (rows = []) => rows.reduce((maxDay, row) => {
    const day = number(row?.actual_date, 0);
    return day > maxDay ? day : maxDay;
  }, 0);

  const observedDaysFromRows = (...rowGroups) => Array.from(new Set(
    rowGroups.flat().map((row) => number(row?.actual_date)).filter((day) => day != null && day > 0)
  )).sort((a, b) => a - b);

  const hasUsableTrajectoryThroughDay = (snapshot, day) => {
    const expectedDay = Math.min(Math.max(1, Math.floor(number(day, 1))), snapshot?.dim || 31);
    const observed = (snapshot?.observedDays || []).filter((value) => value <= expectedDay);
    const required = Math.max(3, Math.ceil(expectedDay * 0.7));
    return observed.length >= Math.min(expectedDay, required)
      && (observed[0] || Infinity) <= Math.min(3, expectedDay);
  };

  const carryCumulative = (series = [], throughDay = series.length) => {
    const result = new Array(series.length).fill(null);
    let last = null;
    for (let index = 0; index < series.length; index += 1) {
      if (index >= throughDay) break;
      const value = number(series[index]);
      if (value != null && value >= 0) last = last == null ? value : Math.max(last, value);
      if (last != null) result[index] = last;
    }
    return result;
  };

  const dailyFromCumulative = (series = []) => series.map((value, index) => {
    if (value == null) return null;
    const previous = index > 0 && series[index - 1] != null ? series[index - 1] : 0;
    return Math.max(0, value - previous);
  });

  const valueAtDay = (series = [], day = 1) => {
    const index = clamp(Math.floor(number(day, 1)) - 1, 0, Math.max(0, series.length - 1));
    for (let cursor = index; cursor >= 0; cursor -= 1) {
      const value = number(series[cursor]);
      if (value != null) return value;
    }
    return 0;
  };

  function buildMemberSeriesFromArchive(json, dim) {
    const clubRoot = Array.isArray(json?.club) ? json.club[0] : {};
    const activeIds = new Set((clubRoot?.circle_user_array || []).map((id) => String(id)));
    const profileById = new Map();
    (json?.club_friend_profile || []).forEach((profile) => {
      const id = String(profile?.friend_viewer_id ?? "");
      if (id) profileById.set(id, profile);
    });

    const membersById = new Map();
    (json?.club_friend_history || []).forEach((row) => {
      const id = String(row?.friend_viewer_id ?? "");
      const day = number(row?.actual_date);
      if (!id || day == null || day < 1 || day > dim) return;
      if (!membersById.has(id)) {
        membersById.set(id, {
          viewerId: id,
          name: row?.friend_name || profileById.get(id)?.name || "Unknown",
          isActive: activeIds.has(id),
          cumulativeSeries: new Array(dim).fill(null),
          dailySeries: new Array(dim).fill(null),
        });
      }
      const member = membersById.get(id);
      const cumulative = number(row?.adjusted_fan_gain_cumulative);
      const daily = number(row?.adjusted_interpolated_fan_gain);
      if (cumulative != null) member.cumulativeSeries[day - 1] = Math.max(0, cumulative);
      if (daily != null) member.dailySeries[day - 1] = Math.max(0, daily);
    });

    profileById.forEach((profile, id) => {
      if (membersById.has(id)) return;
      membersById.set(id, {
        viewerId: id,
        name: profile?.name || (Array.isArray(profile?.names) ? profile.names[0] : null) || "Unknown",
        isActive: activeIds.has(id),
        cumulativeSeries: new Array(dim).fill(null),
        dailySeries: new Array(dim).fill(null),
      });
    });

    return Array.from(membersById.values()).map((member) => {
      const maxDay = Math.max(
        member.cumulativeSeries.reduce((last, value, index) => value != null ? index + 1 : last, 0),
        member.dailySeries.reduce((last, value, index) => value != null ? index + 1 : last, 0)
      );
      const cumulative = carryCumulative(member.cumulativeSeries, maxDay);
      const derivedDaily = dailyFromCumulative(cumulative);
      return {
        ...member,
        cumulativeSeries: cumulative,
        dailySeries: member.dailySeries.map((value, index) => value == null ? derivedDaily[index] : value),
      };
    });
  }

  function buildClubSeries(clubDailyHistory, members, dim, maxAvailableDay) {
    const cumulative = new Array(dim).fill(null);
    const daily = new Array(dim).fill(null);
    const ranks = new Array(dim).fill(null);
    (clubDailyHistory || []).forEach((row) => {
      const day = number(row?.actual_date);
      if (day == null || day < 1 || day > dim) return;
      const cumulativeValue = number(row?.interpolated_fan_count);
      const dailyValue = number(row?.interpolated_fan_gain);
      const rank = number(row?.rank);
      if (cumulativeValue != null && cumulativeValue >= 0) cumulative[day - 1] = cumulativeValue;
      if (dailyValue != null && dailyValue >= 0) daily[day - 1] = dailyValue;
      if (rank != null && rank > 0) ranks[day - 1] = rank;
    });

    const memberCumulative = Array.from({ length: dim }, (_, index) => sum(members.map((member) => member.cumulativeSeries[index] || 0)));
    for (let index = 0; index < Math.min(dim, maxAvailableDay); index += 1) {
      if (cumulative[index] == null && memberCumulative[index] > 0) cumulative[index] = memberCumulative[index];
    }
    const carried = carryCumulative(cumulative, maxAvailableDay);
    const derivedDaily = dailyFromCumulative(carried);
    return {
      cumulativeSeries: carried,
      dailySeries: daily.map((value, index) => index < maxAvailableDay ? (value == null ? derivedDaily[index] : value) : null),
      rankSeries: ranks,
    };
  }

  function parseArchiveSnapshot(json) {
    if (!json || typeof json !== "object") return null;
    const clubRoot = Array.isArray(json.club) ? json.club[0] : null;
    if (!clubRoot) return null;
    const clubId = String(json?._archive?.clubId ?? clubRoot?.circle_id ?? "");
    const monthKey = getMonthKeyFromJson(json);
    const dim = number(json?._archive?.daysInMonth, getDaysInMonth(monthKey));
    const members = buildMemberSeriesFromArchive(json, dim);
    const maxAvailableDay = Math.max(
      number(json?._archive?.completedActualDate, 0),
      maxDayFromRows(json?.club_daily_history),
      maxDayFromRows(json?.club_friend_history)
    );
    const observedDays = observedDaysFromRows(json?.club_daily_history, json?.club_friend_history);
    const clubSeries = buildClubSeries(json?.club_daily_history, members, dim, Math.min(dim, maxAvailableDay));
    const archiveConfig = json?._archive?.frontendConfig || {};
    const clubConfig = archiveConfig?.clubConfig || archiveConfig?.clubConfigById?.[clubId] || {};
    const perMemberTarget = number(clubConfig?.target);
    const activeMemberCount = Array.isArray(clubRoot?.circle_user_array)
      ? clubRoot.circle_user_array.length
      : members.filter((member) => member.isActive).length;
    const clubTarget = perMemberTarget != null ? perMemberTarget * activeMemberCount : null;
    const yearMonth = number(String(monthKey || "").replace("-", ""));
    const monthlyRow = (json?.club_monthly_history || []).find((row) => number(row?.year_month) === yearMonth);
    const finalRank = number(monthlyRow?.rank) || valueAtDay(clubSeries.rankSeries, dim) || null;
    const finalGain = valueAtDay(clubSeries.cumulativeSeries, Math.min(dim, maxAvailableDay));
    return {
      clubId,
      clubName: clubRoot?.name || clubConfig?.name || clubId,
      monthKey,
      dim,
      maxAvailableDay: Math.min(dim, maxAvailableDay),
      observedDays,
      perMemberTarget,
      activeMemberCount,
      clubTarget,
      members,
      ...clubSeries,
      finalGain,
      finalRank,
      isComplete: maxAvailableDay >= dim,
    };
  }

  function buildCurrentSnapshot(club, data, dimOverride = null) {
    if (!club?.id || !data) return null;
    const monthKey = data?.datasetMonthKey || "";
    const dim = number(dimOverride, getDaysInMonth(monthKey));
    const members = (data?.members || []).map((member) => ({
      viewerId: String(member?.viewerId ?? member?.friendViewerId ?? member?.name ?? ""),
      name: member?.name || "Unknown",
      isActive: member?.isActive !== false,
      cumulativeSeries: carryCumulative(
        Array.from({ length: dim }, (_, index) => number(member?.precomputedCumulativeSeries?.[index])),
        Math.min(dim, number(data?.sharedActualDate, dim))
      ),
      dailySeries: Array.from({ length: dim }, (_, index) => number(member?.precomputedDailyGainSeries?.[index])),
    }));
    const maxAvailableDay = clamp(number(data?.sharedActualDate, maxDayFromRows(data?.clubDailyHistory)), 0, dim);
    const observedDays = observedDaysFromRows(data?.clubDailyHistory);
    const clubSeries = buildClubSeries(data?.clubDailyHistory, members, dim, maxAvailableDay);
    const activeMemberCount = members.filter((member) => member.isActive).length;
    const perMemberTarget = number(club?.target);
    return {
      clubId: String(club.id),
      clubName: data?.clubName || club?.name || String(club.id),
      tier: club?.tier || null,
      monthKey,
      dim,
      maxAvailableDay,
      observedDays,
      perMemberTarget,
      activeMemberCount,
      clubTarget: perMemberTarget != null ? perMemberTarget * activeMemberCount : null,
      members,
      ...clubSeries,
      finalGain: maxAvailableDay >= dim ? valueAtDay(clubSeries.cumulativeSeries, dim) : null,
      finalRank: maxAvailableDay >= dim ? valueAtDay(clubSeries.rankSeries, dim) : null,
      isComplete: maxAvailableDay >= dim,
    };
  }

  function compareTrajectory(current, historical, day) {
    if (!current?.clubTarget || !historical?.clubTarget) return null;
    const sampleDays = [];
    const step = Math.max(1, Math.floor(day / 8));
    for (let sampleDay = 1; sampleDay <= day; sampleDay += step) sampleDays.push(sampleDay);
    if (sampleDays[sampleDays.length - 1] !== day) sampleDays.push(day);
    let weightedError = 0;
    let totalWeight = 0;
    sampleDays.forEach((sampleDay) => {
      const currentProgress = valueAtDay(current.cumulativeSeries, sampleDay) / current.clubTarget;
      const historicalProgress = valueAtDay(historical.cumulativeSeries, Math.min(sampleDay, historical.dim)) / historical.clubTarget;
      const weight = 0.45 + (sampleDay / Math.max(1, day));
      weightedError += ((currentProgress - historicalProgress) ** 2) * weight;
      totalWeight += weight;
    });
    return Math.sqrt(weightedError / Math.max(totalWeight, 1));
  }

  function getAnalogCandidates(current, histories, day) {
    return (histories || [])
      .filter((history) => history && history.monthKey !== current.monthKey && history.clubTarget > 0 && history.finalGain > 0 && history.maxAvailableDay >= Math.min(day, history.dim) && hasUsableTrajectoryThroughDay(history, day))
      .map((history) => {
        const distance = compareTrajectory(current, history, day);
        if (distance == null) return null;
        const rankAtDay = valueAtDay(history.rankSeries, Math.min(day, history.dim)) || null;
        return {
          history,
          distance,
          weight: 1 / (0.025 + distance),
          finalTargetRatio: history.finalGain / history.clubTarget,
          rankAtDay,
          rankDelta: rankAtDay && history.finalRank ? history.finalRank - rankAtDay : null,
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 3);
  }

  function getTargetOutlook(forecast, low, high, target) {
    if (!(target > 0)) return { key: "unknown", label: "No target", color: "#9ca3af" };
    if (low >= target) return { key: "likely", label: "Likely above target", color: "#34d399" };
    if (forecast >= target) return { key: "leaning", label: "Leaning above target", color: "#60a5fa" };
    if (high >= target) return { key: "at-risk", label: "Target within range", color: "#fbbf24" };
    return { key: "unlikely", label: "Likely below target", color: "#f87171" };
  }

  function forecastClub(current, histories = [], analysisDay = null, rankHistories = null) {
    if (!current?.clubTarget || !current?.cumulativeSeries?.length) return null;
    const day = clamp(number(analysisDay, current.maxAvailableDay), 1, Math.max(1, current.maxAvailableDay));
    const currentGain = valueAtDay(current.cumulativeSeries, day);
    const currentRank = valueAtDay(current.rankSeries, day) || null;
    if (day >= current.dim && current.maxAvailableDay >= current.dim) {
      return {
        day,
        currentGain,
        forecast: currentGain,
        low: currentGain,
        high: currentGain,
        currentRank,
        projectedRank: currentRank,
        rankLow: currentRank,
        rankHigh: currentRank,
        rankMethod: "actual",
        outlook: getTargetOutlook(currentGain, currentGain, currentGain, current.clubTarget),
        confidence: "Actual",
        confidenceColor: "#34d399",
        historicalSamples: 0,
        analogs: [],
        method: "Completed month actual",
      };
    }

    const remainingDays = Math.max(0, current.dim - day);
    const observedDaily = current.dailySeries.slice(0, day).map((value) => number(value, 0));
    const paceAverage = average(observedDaily);
    const recentWindow = observedDaily.slice(Math.max(0, observedDaily.length - Math.min(7, observedDaily.length)));
    const recentAverage = average(recentWindow);
    const recentWeight = clamp(((day - 10) / 15) * 0.85, 0, 0.85);
    const blendedDaily = recentAverage * recentWeight + paceAverage * (1 - recentWeight);
    const baselineForecast = Math.max(currentGain, currentGain + blendedDaily * remainingDays);
    const paceForecast = Math.max(currentGain, paceAverage * current.dim);
    const analogs = getAnalogCandidates(current, histories, day);
    const historicalForecast = analogs.length
      ? weightedAverage(analogs.map((analog) => ({ value: analog.finalTargetRatio * current.clubTarget, weight: analog.weight })))
      : null;
    const elapsedRatio = day / Math.max(1, current.dim);
    let historyWeight = 0;
    if (historicalForecast != null && day >= 10) {
      if (day <= 15) historyWeight = ((day - 9) / 6) * 0.25;
      else if (day <= 21) historyWeight = 0.25 - (((day - 15) / 6) * 0.05);
      else historyWeight = 0.20 * ((current.dim - day) / Math.max(1, current.dim - 21));
      historyWeight = clamp(historyWeight, 0, 0.25);
    }
    const forecast = Math.round(Math.max(currentGain, (historicalForecast || 0) * historyWeight + baselineForecast * (1 - historyWeight)));
    const scenarios = [baselineForecast, paceForecast, ...analogs.map((analog) => {
      const analogFinish = analog.finalTargetRatio * current.clubTarget;
      return analogFinish * historyWeight + baselineForecast * (1 - historyWeight);
    })].filter((value) => Number.isFinite(value) && value >= currentGain);
    let uncertaintyFloor = 0.25 * (1 - elapsedRatio) + 0.06;
    if (analogs.length < 2) uncertaintyFloor += 0.08;
    const low = Math.round(Math.max(currentGain, Math.min(quantile(scenarios, 0.2) ?? forecast, forecast * (1 - uncertaintyFloor))));
    const high = Math.round(Math.max(forecast, quantile(scenarios, 0.8) ?? forecast, forecast * (1 + uncertaintyFloor)));

    let projectedRank = null;
    let rankLow = null;
    let rankHigh = null;
    let rankMethod = "unavailable";
    const rankPool = Array.isArray(rankHistories) ? rankHistories : histories;
    const currentProgress = currentGain / current.clubTarget;
    const pooledRankAnalogs = currentRank ? rankPool
      .filter((history) => history && history.monthKey < current.monthKey && history.clubTarget > 0 && history.finalRank > 0 && history.maxAvailableDay >= Math.min(day, history.dim) && hasUsableTrajectoryThroughDay(history, day))
      .map((history) => {
        const rankAtDay = valueAtDay(history.rankSeries, Math.min(day, history.dim));
        if (!(rankAtDay > 0)) return null;
        const progressAtDay = valueAtDay(history.cumulativeSeries, Math.min(day, history.dim)) / history.clubTarget;
        const targetScaleDistance = Math.abs(Math.log((current.perMemberTarget || 1) / (history.perMemberTarget || 1)));
        const distance = Math.abs(Math.log(currentRank / rankAtDay)) * 0.55
          + Math.abs(currentProgress - progressAtDay) * 1.2
          + targetScaleDistance * 0.08;
        return {
          history,
          rankAtDay,
          rankRatio: history.finalRank / rankAtDay,
          distance,
          weight: 1 / (0.05 + distance),
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 8) : [];
    if (currentRank && pooledRankAnalogs.length) {
      const logRankRatio = weightedAverage(pooledRankAnalogs.map((analog) => ({ value: Math.log(analog.rankRatio), weight: analog.weight })));
      const rawProjectedRank = currentRank * Math.exp(logRankRatio);
      // External clubs are not observed, so historical rank movement should only
      // influence the estimate gradually. These weights were selected from
      // rolling-origin checks across the available completed club-months.
      const rankModelWeight = day < 10 ? 0.05 : day < 15 ? 0.20 : day < 20 ? 0.25 : 0.30;
      projectedRank = Math.max(1, Math.round(currentRank + ((rawProjectedRank - currentRank) * rankModelWeight)));
      const rankScenarios = pooledRankAnalogs.map((analog) => Math.max(1, currentRank + (((currentRank * analog.rankRatio) - currentRank) * rankModelWeight)));
      const rangeFloor = Math.max(12, Math.round(currentRank * (0.45 * (1 - elapsedRatio) + 0.10)));
      rankLow = Math.max(1, Math.round(Math.min(quantile(rankScenarios, 0.1) ?? projectedRank, projectedRank - rangeFloor)));
      rankHigh = Math.max(projectedRank, Math.round(Math.max(quantile(rankScenarios, 0.9) ?? projectedRank, projectedRank + rangeFloor)));
      rankMethod = "pooled historical global-rank movement";
    } else if (currentRank && day < 21) {
      projectedRank = currentRank;
      const rangeFloor = Math.max(20, Math.round(currentRank * (0.55 * (1 - elapsedRatio) + 0.15)));
      rankLow = Math.max(1, currentRank - rangeFloor);
      rankHigh = currentRank + rangeFloor;
      rankMethod = "current-rank baseline; insufficient comparable history";
    } else if (currentRank) {
      const visibleRanks = current.rankSeries.slice(0, day).filter((value) => number(value) != null);
      const recentRanks = visibleRanks.slice(-Math.min(5, visibleRanks.length));
      if (recentRanks.length >= 2) {
        const dailyChange = (recentRanks[recentRanks.length - 1] - recentRanks[0]) / (recentRanks.length - 1);
        projectedRank = Math.max(1, Math.round(currentRank + dailyChange * remainingDays));
        const rangeFloor = Math.max(10, Math.round(currentRank * 0.25));
        rankLow = Math.max(1, projectedRank - rangeFloor);
        rankHigh = projectedRank + rangeFloor;
        rankMethod = "recent trend only";
      }
    }

    const confidence = analogs.length >= 3 && day >= 15 ? "Moderate" : analogs.length >= 2 && day >= 7 ? "Developing" : "Low";
    const confidenceColor = confidence === "Moderate" ? "#60a5fa" : confidence === "Developing" ? "#fbbf24" : "#f87171";
    return {
      day,
      currentGain,
      forecast,
      low,
      high,
      currentRank,
      projectedRank,
      rankLow,
      rankHigh,
      rankMethod,
      outlook: getTargetOutlook(forecast, low, high, current.clubTarget),
      confidence,
      confidenceColor,
      historicalSamples: analogs.length,
      analogs,
      method: analogs.length ? "Target-normalized analog + recent run rate" : "Recent run rate fallback",
    };
  }

  function findHistoricalTwins(current, histories = [], analysisDay = null, limit = 3) {
    if (!current?.clubTarget) return [];
    const day = clamp(number(analysisDay, current.maxAvailableDay), 1, Math.max(1, current.maxAvailableDay));
    return getAnalogCandidates(current, histories, day).slice(0, limit).map((analog) => ({
      monthKey: analog.history.monthKey,
      similarity: clamp(Math.round((1 - Math.min(1, analog.distance)) * 100), 0, 100),
      distance: analog.distance,
      progressAtDay: valueAtDay(analog.history.cumulativeSeries, Math.min(day, analog.history.dim)) / analog.history.clubTarget,
      finalProgress: analog.history.finalGain / analog.history.clubTarget,
      finalGain: analog.history.finalGain,
      finalRank: analog.history.finalRank,
      rankAtDay: analog.rankAtDay,
      perMemberTarget: analog.history.perMemberTarget,
      activeMemberCount: analog.history.activeMemberCount,
    }));
  }

  const memberValueAtDay = (member, day) => valueAtDay(member?.cumulativeSeries || [], day);

  function computeMomentum(snapshot, analysisDay = null) {
    if (!snapshot?.clubTarget) return { ready: false, memberAlerts: [], clubAlert: null, reason: "No club target or daily data." };
    const day = clamp(number(analysisDay, snapshot.maxAvailableDay), 1, Math.max(1, snapshot.maxAvailableDay));
    if (day < 10) return { ready: false, memberAlerts: [], clubAlert: null, reason: "Momentum requires at least 10 elapsed days." };
    const remainingDays = Math.max(0, snapshot.dim - day);
    const impactHorizon = Math.max(remainingDays, 3);
    const perMemberDailyTarget = snapshot.perMemberTarget / Math.max(1, snapshot.dim);
    const memberAlerts = snapshot.members.filter((member) => member.isActive).map((member) => {
      const daily = member.dailySeries.slice(0, day).map((value) => number(value, 0));
      const recent = daily.slice(-3);
      const baseline = daily.slice(Math.max(0, daily.length - 10), Math.max(0, daily.length - 3));
      const recentAverage = average(recent);
      const baselineAverage = average(baseline);
      const delta = recentAverage - baselineAverage;
      const relativeChange = baselineAverage > 0 ? delta / baselineAverage : (recentAverage > 0 ? Infinity : 0);
      const projectedImpact = Math.abs(delta) * impactHorizon;
      const largeRelativeChange = Math.abs(relativeChange) >= 0.75;
      const meaningfulDailyVolume = Math.max(recentAverage, baselineAverage) >= perMemberDailyTarget * 0.25;
      const meaningfulClubImpact = projectedImpact >= snapshot.clubTarget * 0.008;
      if (!largeRelativeChange || !meaningfulDailyVolume || !meaningfulClubImpact) return null;
      return {
        viewerId: member.viewerId,
        name: member.name,
        direction: delta >= 0 ? "up" : "down",
        recentAverage,
        baselineAverage,
        delta,
        relativeChange,
        projectedImpact,
      };
    }).filter(Boolean).sort((a, b) => b.projectedImpact - a.projectedImpact);

    const up = memberAlerts.filter((alert) => alert.direction === "up");
    const down = memberAlerts.filter((alert) => alert.direction === "down");
    const strongest = sum(up.map((alert) => alert.projectedImpact)) >= sum(down.map((alert) => alert.projectedImpact)) ? up : down;
    const combinedImpact = sum(strongest.map((alert) => alert.projectedImpact));
    const minimumAffected = Math.max(3, Math.ceil(snapshot.activeMemberCount * 0.1));
    const clubAlert = strongest.length >= minimumAffected && combinedImpact >= snapshot.clubTarget * 0.04
      ? { direction: strongest[0].direction, affectedMembers: strongest.length, combinedImpact }
      : null;
    return { ready: true, memberAlerts, clubAlert, reason: null };
  }

  function contributionRows(snapshot, day) {
    const playerRows = snapshot.members.map((member) => ({
      viewerId: member.viewerId,
      name: member.name,
      gain: memberValueAtDay(member, day),
      isActive: member.isActive,
    })).filter((row) => row.gain > 0).sort((a, b) => b.gain - a.gain);
    const clubTotal = valueAtDay(snapshot.cumulativeSeries, day);
    const playerTotal = sum(playerRows.map((row) => row.gain));
    const denominator = Math.max(clubTotal, playerTotal, 1);
    const rows = playerRows.map((row) => ({ ...row, share: row.gain / denominator }));
    const residual = Math.max(0, clubTotal - playerTotal);
    if (residual > 0) rows.push({ viewerId: "other", name: "Other / roster changes", gain: residual, share: residual / denominator, isActive: false, isResidual: true });
    return { rows: rows.sort((a, b) => b.gain - a.gain), total: denominator };
  }

  function computeResilience(snapshot, analysisDay = null) {
    if (!snapshot?.clubTarget) return null;
    const day = clamp(number(analysisDay, snapshot.maxAvailableDay), 1, Math.max(1, snapshot.maxAvailableDay));
    const current = contributionRows(snapshot, day);
    const playersOnly = current.rows.filter((row) => !row.isResidual);
    const topShare = (count) => sum(playersOnly.slice(0, count).map((row) => row.share));
    const topOneShare = topShare(1);
    const topThreeShare = topShare(3);
    const topFiveShare = topShare(5);
    const comparisonDay = Math.max(1, day - 7);
    const previous = contributionRows(snapshot, comparisonDay);
    const previousTopFive = sum(previous.rows.filter((row) => !row.isResidual).slice(0, 5).map((row) => row.share));
    const effectiveContributors = current.rows.length
      ? 1 / sum(current.rows.map((row) => row.share ** 2))
      : 0;
    const sustainedConcentration = day >= 7 && ((topFiveShare >= 0.60 && previousTopFive >= 0.55) || (topThreeShare >= 0.50 && previousTopFive >= 0.55));
    return {
      day,
      totalGain: current.total,
      contributions: current.rows,
      topOneShare,
      topThreeShare,
      topFiveShare,
      previousTopFive,
      concentrationChange: topFiveShare - previousTopFive,
      effectiveContributors,
      sustainedConcentration,
      alert: sustainedConcentration
        ? `Five members account for ${(topFiveShare * 100).toFixed(1)}% of club gain and concentration has remained elevated.`
        : null,
    };
  }

  function standardDeviation(values = []) {
    if (!values.length) return 0;
    const mean = average(values);
    return Math.sqrt(average(values.map((value) => (value - mean) ** 2)));
  }

  function profileMembers(snapshots = [], analysisDay = null) {
    const availableDays = snapshots.map((snapshot) => snapshot?.maxAvailableDay || 0).filter((value) => value > 0);
    if (!availableDays.length) return { ready: false, reason: "No member history is loaded.", groups: [] };
    const day = Math.min(number(analysisDay, Math.min(...availableDays)), ...availableDays);
    if (day < 7) return { ready: false, reason: "Member archetypes require at least 7 elapsed days.", groups: [] };
    const candidates = [];
    snapshots.forEach((snapshot) => {
      snapshot.members.filter((member) => member.isActive).forEach((member) => {
        const daily = member.dailySeries.slice(0, day).map((value) => number(value, 0));
        const total = sum(daily);
        if (total <= 0) return;
        const activeDays = daily.filter((value) => value > 0).length;
        const activeRate = activeDays / day;
        const mean = average(daily);
        const cv = mean > 0 ? standardDeviation(daily) / mean : 0;
        const topTwoShare = sum([...daily].sort((a, b) => b - a).slice(0, 2)) / total;
        const recentFive = average(daily.slice(-Math.min(5, daily.length)));
        const previousFive = average(daily.slice(Math.max(0, daily.length - 10), Math.max(0, daily.length - 5)));
        const firstHalf = average(daily.slice(0, Math.max(1, Math.floor(day / 2))));
        const secondHalf = average(daily.slice(Math.max(1, Math.floor(day / 2))));
        const monthMatch = String(snapshot.monthKey || "").match(/^(\d{4})-(\d{2})$/);
        const year = monthMatch ? Number(monthMatch[1]) : 2026;
        const month = monthMatch ? Number(monthMatch[2]) : 1;
        const weekendValues = [];
        const weekdayValues = [];
        daily.forEach((value, index) => {
          const weekday = new Date(year, month - 1, index + 1).getDay();
          if (weekday === 0 || weekday === 6) weekendValues.push(value); else weekdayValues.push(value);
        });
        candidates.push({
          viewerId: member.viewerId,
          name: member.name,
          clubName: snapshot.clubName,
          clubTier: snapshot.tier,
          total,
          progressRatio: snapshot.perMemberTarget > 0 ? total / snapshot.perMemberTarget : 0,
          activeRate,
          cv,
          topTwoShare,
          recentFive,
          previousFive,
          firstHalf,
          secondHalf,
          weekendAverage: average(weekendValues),
          weekdayAverage: average(weekdayValues),
          weekendDays: weekendValues.length,
        });
      });
    });
    const anchorCutoff = quantile(candidates.map((candidate) => candidate.progressRatio), 0.85) || Infinity;
    const labels = [
      { key: "anchor", label: "High-volume anchor", color: "#fbbf24" },
      { key: "consistent", label: "Consistent contributor", color: "#34d399" },
      { key: "weekend", label: "Weekend-focused", color: "#60a5fa" },
      { key: "late", label: "Late-month accelerator", color: "#a78bfa" },
      { key: "climber", label: "Momentum climber", color: "#2dd4bf" },
      { key: "burst", label: "Burst contributor", color: "#f97316" },
      { key: "intermittent", label: "Intermittent contributor", color: "#9ca3af" },
      { key: "mixed", label: "Mixed / emerging pattern", color: "#64748b" },
    ];
    const classified = candidates.map((candidate) => {
      const matches = [];
      if (candidate.progressRatio >= anchorCutoff && candidate.activeRate >= 0.6) matches.push("anchor");
      if (candidate.activeRate >= 0.8 && candidate.cv <= 0.9) matches.push("consistent");
      if (candidate.weekendDays >= 2 && candidate.weekendAverage >= candidate.weekdayAverage * 1.6 && candidate.weekendAverage > 0) matches.push("weekend");
      if (day >= 14 && candidate.secondHalf >= candidate.firstHalf * 1.5 && candidate.secondHalf > 0) matches.push("late");
      if (day >= 10 && candidate.previousFive > 0 && candidate.recentFive >= candidate.previousFive * 1.6) matches.push("climber");
      if (candidate.topTwoShare >= 0.45 || candidate.cv >= 1.5) matches.push("burst");
      if (candidate.activeRate >= 0.2 && candidate.activeRate < 0.6) matches.push("intermittent");
      return { ...candidate, primary: matches[0] || "mixed", secondary: matches.slice(1) };
    });
    const groups = labels.map((meta) => ({
      ...meta,
      members: classified.filter((member) => member.primary === meta.key).sort((a, b) => b.progressRatio - a.progressRatio),
    })).filter((group) => group.members.length);
    return { ready: true, day, memberCount: classified.length, groups };
  }

  function buildTransferRecommendations(snapshots = [], historiesByClub = {}, analysisDay = null) {
    const usableSnapshots = (snapshots || []).filter((snapshot) => snapshot?.perMemberTarget > 0 && snapshot?.members?.length);
    if (!usableSnapshots.length) return { ready: false, reason: "No current member data is available.", recommendations: [], counts: {} };
    const availableDays = usableSnapshots.map((snapshot) => snapshot.maxAvailableDay || 0).filter((day) => day > 0);
    const day = clamp(number(analysisDay, Math.min(...availableDays)), 1, Math.min(...availableDays));
    if (day < 10) return { ready: false, day, reason: "Wait until Day 10 before using transfer recommendations. Early-month pace changes too quickly for responsible placement guidance.", recommendations: [], counts: {} };

    const tierTargets = Array.from(usableSnapshots.reduce((map, snapshot) => {
      const tier = snapshot.tier || "Unranked";
      const current = map.get(tier);
      if (!current || snapshot.perMemberTarget > current.target) map.set(tier, { tier, target: snapshot.perMemberTarget });
      return map;
    }, new Map()).values()).sort((a, b) => b.target - a.target);
    const historyPool = Array.isArray(historiesByClub)
      ? historiesByClub
      : Object.values(historiesByClub || {}).flat().filter(Boolean);

    const recommendations = [];
    usableSnapshots.forEach((snapshot) => {
      const currentTierIndex = tierTargets.findIndex((entry) => entry.tier === snapshot.tier);
      snapshot.members.filter((member) => member.isActive).forEach((member) => {
        const daily = member.dailySeries.slice(0, day).map((value) => number(value, 0));
        const currentGain = memberValueAtDay(member, day);
        const wholeMonthAverage = currentGain / Math.max(1, day);
        const recentAverage = average(daily.slice(-Math.min(7, day)));
        const priorAverage = day >= 10
          ? average(daily.slice(Math.max(0, day - 14), Math.max(0, day - 7)))
          : wholeMonthAverage;
        const recentWeight = clamp((day - 7) / 18, 0, 0.65);
        const projectedDaily = recentAverage * recentWeight + wholeMonthAverage * (1 - recentWeight);
        const projected = day >= snapshot.dim
          ? currentGain
          : Math.max(currentGain, Math.round(currentGain + projectedDaily * (snapshot.dim - day)));
        const projectedRatio = projected / snapshot.perMemberTarget;
        let idleDays = 0;
        for (let index = daily.length - 1; index >= 0 && daily[index] <= 0; index -= 1) idleDays += 1;
        const paceChange = priorAverage > 0 ? (recentAverage - priorAverage) / priorAverage : recentAverage > 0 ? Infinity : 0;
        const trend = paceChange >= 0.20 ? "rising" : paceChange <= -0.20 ? "falling" : "steady";

        const historicalRecordsRaw = historyPool.flatMap((history) => {
          if (!history || history.monthKey >= snapshot.monthKey || !(history.perMemberTarget > 0)) return [];
          const historicalMember = (history.members || []).find((candidate) => String(candidate.viewerId) === String(member.viewerId));
          if (!historicalMember) return [];
          const finalGain = memberValueAtDay(historicalMember, Math.min(history.dim, history.maxAvailableDay));
          return finalGain > 0 ? [{
            monthKey: history.monthKey,
            clubName: history.clubName,
            target: history.perMemberTarget,
            gain: finalGain,
            targetRatio: finalGain / history.perMemberTarget,
          }] : [];
        }).sort((a, b) => b.monthKey.localeCompare(a.monthKey));
        const historicalRecords = Array.from(historicalRecordsRaw.reduce((records, record) => {
          if (!records.has(record.monthKey)) records.set(record.monthKey, record);
          return records;
        }, new Map()).values()).slice(0, 3);
        const priorTargetsMet = historicalRecords.filter((record) => record.targetRatio >= 1).length;
        const historicalAverageRatio = historicalRecords.length ? average(historicalRecords.map((record) => record.targetRatio)) : null;

        const higherTiers = currentTierIndex > 0 ? tierTargets.slice(0, currentTierIndex) : [];
        const supportableHigherTier = [...higherTiers].reverse().find((entry) => projected >= entry.target * 1.05) || null;
        const lowerTiers = currentTierIndex >= 0 ? tierTargets.slice(currentTierIndex + 1) : [];
        const supportableLowerTier = lowerTiers.find((entry) => projected >= entry.target * 0.85)
          || lowerTiers[lowerTiers.length - 1]
          || null;

        let category = "keep";
        let suggestedTier = snapshot.tier;
        if (supportableHigherTier && projectedRatio >= 1.15 && trend !== "falling") {
          category = "promote";
          suggestedTier = supportableHigherTier.tier;
        } else if (projectedRatio < 0.75 || (idleDays >= 3 && projectedRatio < 0.88)) {
          category = "move-down";
          suggestedTier = supportableLowerTier?.tier || "Roster review";
        } else if (projectedRatio < 0.95 || (trend === "falling" && projectedRatio < 1.08)) {
          category = "watch";
        }

        const confidence = day >= 21 && historicalRecords.length >= 1
          ? "Stronger evidence"
          : day >= 14
            ? "Developing evidence"
            : "Early signal";
        const currentPercent = Math.round(projectedRatio * 100);
        const historySentence = historicalRecords.length
          ? `${priorTargetsMet}/${historicalRecords.length} prior archived month${historicalRecords.length === 1 ? "" : "s"} met the target active at that time.`
          : "No usable prior-month record was found, so this relies on the current month only.";
        let commentary = `Projected to finish at ${currentPercent}% of the current ${snapshot.tier} quota; recent pace is ${trend}. ${historySentence}`;
        let action = "Keep the current placement and recheck if pace changes materially.";
        if (category === "promote") action = `Review for ${suggestedTier}. Confirm roster space and use officer context before moving.`;
        if (category === "move-down") action = suggestedTier === "Roster review"
          ? "Review roster fit directly; the data does not support an automatic removal decision."
          : `Review a move to ${suggestedTier}, where the projected pace is a closer match.`;
        if (category === "watch") action = "Check in or coach first, then reassess after several more daily updates before moving.";

        recommendations.push({
          viewerId: member.viewerId,
          name: member.name,
          clubId: snapshot.clubId,
          clubName: snapshot.clubName,
          currentTier: snapshot.tier,
          currentTarget: snapshot.perMemberTarget,
          category,
          suggestedTier,
          currentGain,
          projected,
          projectedRatio,
          recentAverage,
          wholeMonthAverage,
          idleDays,
          trend,
          confidence,
          historicalRecords,
          historicalAverageRatio,
          priorTargetsMet,
          commentary,
          action,
        });
      });
    });

    const categoryPriority = { "promote": 0, "move-down": 1, "watch": 2, "keep": 3 };
    recommendations.sort((a, b) => {
      const categoryDifference = categoryPriority[a.category] - categoryPriority[b.category];
      if (categoryDifference) return categoryDifference;
      if (a.category === "move-down" || a.category === "watch") return a.projectedRatio - b.projectedRatio;
      return b.projectedRatio - a.projectedRatio;
    });
    const counts = recommendations.reduce((result, recommendation) => {
      result[recommendation.category] = (result[recommendation.category] || 0) + 1;
      return result;
    }, { promote: 0, "move-down": 0, watch: 0, keep: 0 });
    return { ready: true, day, recommendations, counts, tierTargets };
  }

  return {
    average,
    buildTransferRecommendations,
    buildCurrentSnapshot,
    computeMomentum,
    computeResilience,
    findHistoricalTwins,
    forecastClub,
    getDaysInMonth,
    parseArchiveSnapshot,
    profileMembers,
    quantile,
    sum,
    valueAtDay,
  };
});
