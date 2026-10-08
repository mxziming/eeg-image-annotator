/* Logical events are independent of image dimensions and channel calibration. */
(function (root) {
  const eegChannels = ["F3M2", "F4M1", "C3M2", "C4M1", "O1M2", "O2M1"];
  const channelEventOverlapThreshold = 0.5;
  const eventDefinitions = {
    k_complex: { csvType: "K", channelMode: "overlap", allowed: eegChannels },
    spindle: { csvType: "S", channelMode: "overlap", allowed: eegChannels },
    micro_arousal: { csvType: "A", channelMode: "global", allowed: ["GLOBAL", ...eegChannels] },
    rem: { csvType: "REM", channelMode: "joint-eog", allowed: ["LOC;ROC"] },
    sem: { csvType: "SEM", channelMode: "joint-eog", allowed: ["LOC;ROC"] },
    mbm: { csvType: "MBM", channelMode: "global", allowed: ["GLOBAL"] }
  };
  function channel(value) {
    const normalized = String(value).toUpperCase().replace(/^EEG\s*/, "").replace(/[^A-Z0-9]/g, "")
      .replace(/A([12])$/, "M$1").replace(/^(F3|C3|O1)CLE$/, "$1M2")
      .replace(/^(F4|C4|O2)CLE$/, "$1M1");
    return normalized === "LOCROC" || normalized === "ROCLOC" ? "LOC;ROC" : normalized;
  }
  function type(value) {
    const key = String(value).toLowerCase().replace(/_/g, "-");
    const types = { k: "k_complex", "k-complex": "k_complex", kcomplex: "k_complex",
      s: "spindle", spindle: "spindle", a: "micro_arousal", arousal: "micro_arousal",
      "micro-arousal": "micro_arousal", rem: "rem", "rapid-eye-movement": "rem",
      sem: "sem", "slow-eye-movement": "sem", mbm: "mbm",
      "major-body-movement": "mbm" };
    if (!types[key]) throw new Error(`不支持的事件类型：${value}`);
    return types[key];
  }
  function generatedEventId(identity) {
    let hash = 2166136261;
    for (let index = 0; index < identity.length; index += 1) {
      hash ^= identity.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return `import-${(hash >>> 0).toString(16).padStart(8, "0")}`;
  }
  function readRows(rows, options = {}) {
    const headers = rows[0].map(v => v.replace(/^\uFEFF/, "").trim().toLowerCase());
    const required = ["type", "start_epoch", "start_offset", "end_epoch", "end_offset", "channel",
      "dataset_name", "image_name", "duration_s"];
    if (required.some(c => !headers.includes(c))) throw new Error(`CSV 需要包含：${required.join(", ")}`);
    const epochLengthSec = Number(options.epochLengthSec || 30);
    if (!(epochLengthSec > 0)) throw new Error("epochLengthSec 必须为正数。");
    const parsed = [];
    for (const row of rows.slice(1)) {
      if (!row.some(v => String(v).trim())) continue;
      const get = c => String(row[headers.indexOf(c)] ?? "").trim();
      const times = ["start_epoch", "start_offset", "end_epoch", "end_offset"].map(c => {
        if (!get(c) || !Number.isFinite(Number(get(c)))) throw new Error(`非法时间字段：${c}`);
        return Number(get(c));
      });
      if (!Number.isInteger(times[0]) || !Number.isInteger(times[2]))
        throw new Error("epoch 必须是整数。");
      const eventType = type(get("type"));
      if (!get("dataset_name") || !get("image_name"))
        throw new Error("dataset_name 和 image_name 不能为空。");
      if (!Number.isFinite(Number(get("duration_s"))) || Number(get("duration_s")) <= 0)
        throw new Error("duration_s 必须是正数。");
      if (!get("channel")) throw new Error("channel 不能为空。");
      const startSec = times[0] * epochLengthSec + times[1];
      const endSec = times[2] * epochLengthSec + times[3];
      if (!(endSec > startSec) || Math.abs((endSec - startSec) - Number(get("duration_s"))) > 0.001)
        throw new Error("duration_s 与 epoch/offset 时间区间不一致。");
      const normalizedChannel = channel(get("channel"));
      const detected = normalizedChannel === "LOC;ROC"
        ? [normalizedChannel]
        : get("channel").split(";").map(channel);
      const definition = eventDefinitions[eventType];
      for (const c of detected) {
        if (!definition.allowed.includes(c)) throw new Error(`${definition.csvType} 不允许通道 ${c}。`);
        const start = epochPosition(startSec, epochLengthSec);
        const end = epochPosition(endSec, epochLengthSec);
        parsed.push({ eventType, datasetName: get("dataset_name"), recordingName: get("image_name"),
          startEpoch: start.epoch, startOffset: start.offset, endEpoch: end.epoch, endOffset: end.offset,
          startSec, endSec, durationS: Number(get("duration_s")),
          channel: c, suppliedId: get("annotation_id") });
      }
    }

    const supplied = new Map();
    const clusters = [];
    const sorted = parsed.sort((a, b) => a.startSec - b.startSec || a.endSec - b.endSec ||
      a.channel.localeCompare(b.channel));
    for (const item of sorted) {
      const identity = JSON.stringify([item.datasetName, item.recordingName, item.eventType,
        item.startEpoch, item.startOffset, item.endEpoch, item.endOffset]);
      if (item.suppliedId) {
        const existing = supplied.get(item.suppliedId);
        if (existing) {
          const sameScope = existing.eventType === item.eventType &&
            existing.datasetName === item.datasetName && existing.recordingName === item.recordingName;
          if (!sameScope) throw new Error(`annotation_id ${item.suppliedId} 对应了不同的事件类型或记录。`);
          const priorInterval = existing.channelIntervals.find(interval => interval.channel === item.channel);
          if (priorInterval) {
            const priorStart = priorInterval.startEpoch * epochLengthSec + priorInterval.startOffset;
            const priorEnd = priorInterval.endEpoch * epochLengthSec + priorInterval.endOffset;
            if (item.startSec > priorEnd + 0.001 || priorStart > item.endSec + 0.001)
              throw new Error(`annotation_id ${item.suppliedId} 在通道 ${item.channel} 上包含不连续的时间片段。`);
            const mergedStart = Math.min(priorStart, item.startSec);
            const mergedEnd = Math.max(priorEnd, item.endSec);
            Object.assign(priorInterval, intervalFromSeconds(item.channel, mergedStart, mergedEnd, epochLengthSec));
          } else {
            existing.channels.push(item.channel);
            existing.channelIntervals.push(intervalFromItem(item));
          }
          existing.startSec = Math.min(existing.startSec, item.startSec);
          existing.endSec = Math.max(existing.endSec, item.endSec);
          const envelope = eventFromInterval(existing, existing.startSec, existing.endSec,
            existing.channels, existing.eventId, epochLengthSec, existing.channelIntervals);
          Object.assign(existing, envelope, { identity: existing.identity,
            startSec: existing.startSec, endSec: existing.endSec });
        } else {
          const event = eventFromInterval(item, item.startSec, item.endSec, [item.channel], item.suppliedId,
            epochLengthSec, [item]);
          event.identity = identity;
          event.startSec = item.startSec;
          event.endSec = item.endSec;
          supplied.set(item.suppliedId, event);
        }
        continue;
      }
      if (!eventDefinitions[item.eventType] || eventDefinitions[item.eventType].channelMode !== "overlap") {
        clusters.push({ ...item, commonStart: item.startSec, commonEnd: item.endSec,
          unionStart: item.startSec, unionEnd: item.endSec, channels: [item.channel], members: [item] });
        continue;
      }
      const eligible = clusters.map((cluster, index) => ({ cluster, index }))
        .filter(({ cluster }) => cluster.eventType === item.eventType &&
          cluster.datasetName === item.datasetName && cluster.recordingName === item.recordingName &&
          !cluster.channels.includes(item.channel))
        .map(({ cluster, index }) => {
          const commonStart = Math.max(cluster.commonStart, item.startSec);
          const commonEnd = Math.min(cluster.commonEnd, item.endSec);
          const intersection = commonEnd - commonStart;
          const coversAll = intersection > 0 &&
            intersection / (item.endSec - item.startSec) >= channelEventOverlapThreshold &&
            cluster.members.every(member =>
              intersection / (member.endSec - member.startSec) >= channelEventOverlapThreshold);
          return { cluster, index, commonStart, commonEnd, intersection, coversAll };
        }).filter(candidate => candidate.coversAll)
        .sort((a, b) => b.intersection - a.intersection || a.index - b.index);
      if (eligible.length) {
        const match = eligible[0];
        match.cluster.commonStart = match.commonStart;
        match.cluster.commonEnd = match.commonEnd;
        match.cluster.unionStart = Math.min(match.cluster.unionStart, item.startSec);
        match.cluster.unionEnd = Math.max(match.cluster.unionEnd, item.endSec);
        match.cluster.channels.push(item.channel);
        match.cluster.members.push(item);
      } else {
        clusters.push({ ...item, commonStart: item.startSec, commonEnd: item.endSec,
          unionStart: item.startSec, unionEnd: item.endSec, channels: [item.channel], members: [item] });
      }
    }

    const generated = clusters.map(cluster => {
      const identity = JSON.stringify([cluster.datasetName, cluster.recordingName, cluster.eventType,
        cluster.unionStart, cluster.unionEnd, [...cluster.channels].sort()]);
      return eventFromInterval(cluster, cluster.unionStart, cluster.unionEnd, cluster.channels,
        generatedEventId(identity), epochLengthSec, cluster.members);
    });
    return [...supplied.values()].map(({ identity, startSec, endSec, ...event }) => event).concat(generated);
  }
  function intervalFromItem(item) {
    return { channel: item.channel, startEpoch: item.startEpoch, startOffset: item.startOffset,
      endEpoch: item.endEpoch, endOffset: item.endOffset, durationS: item.durationS };
  }
  function epochPosition(seconds, epochLengthSec) {
    const epoch = Math.floor(seconds / epochLengthSec + 1e-12);
    return { epoch, offset: seconds - epoch * epochLengthSec };
  }
  function intervalFromSeconds(channelName, startSec, endSec, epochLengthSec) {
    const start = epochPosition(startSec, epochLengthSec);
    const end = epochPosition(endSec, epochLengthSec);
    return { channel: channelName, startEpoch: start.epoch, startOffset: start.offset,
      endEpoch: end.epoch, endOffset: end.offset, durationS: endSec - startSec };
  }
  function eventFromInterval(source, startSec, endSec, channels, eventId, epochLengthSec, members = []) {
    const startEpoch = Math.floor(startSec / epochLengthSec + 1e-12);
    const endEpoch = Math.floor(endSec / epochLengthSec + 1e-12);
    const channelIntervals = members.map(member => member.channel
      ? intervalFromItem(member)
      : { ...member });
    return { eventId, eventType: source.eventType, datasetName: source.datasetName,
      recordingName: source.recordingName, startEpoch, startOffset: startSec - startEpoch * epochLengthSec,
      endEpoch, endOffset: endSec - endEpoch * epochLengthSec, durationS: endSec - startSec,
      channels: [...channels], channelIntervals };
  }
  function project(annotation, image, width, height) {
    const wanted = annotation.channel === "GLOBAL" ? image.layout.channels
      : annotation.channel === "LOC;ROC" ? image.layout.channels.filter(c => ["LOC", "ROC"].includes(channel(c.name)))
      : image.layout.channels.filter(c => channel(c.name) === annotation.channel);
    if (!wanted.length || !(image.layout.plotRightPct > image.layout.plotLeftPct)) return null;
    const topPct = Math.min(...wanted.map(region => region.topPct));
    const bottomPct = Math.max(...wanted.map(region => region.bottomPct));
    const left = image.layout.plotLeftPct / 100 * width;
    const span = (image.layout.plotRightPct - image.layout.plotLeftPct) / 100 * width;
    return { x1: left + annotation.startFraction * span, x2: left + annotation.endFraction * span,
      y1: topPct / 100 * height, y2: bottomPct / 100 * height };
  }
  root.EventGeometry = { channels: eegChannels, eegChannels, eventDefinitions,
    channelEventOverlapThreshold, channel, type, readRows, project };
  if (typeof module !== "undefined") module.exports = root.EventGeometry;
})(globalThis);
