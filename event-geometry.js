/* Logical events are independent of image dimensions and channel calibration. */
(function (root) {
  const eegChannels = ["F3M2", "F4M1", "C3M2", "C4M1", "O1M2", "O2M1"];
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
  function readRows(rows) {
    const headers = rows[0].map(v => v.replace(/^\uFEFF/, "").trim().toLowerCase());
    const required = ["type", "start_epoch", "start_offset", "end_epoch", "end_offset", "channel",
      "dataset_name", "image_name", "duration_s", "annotation_id"];
    if (required.some(c => !headers.includes(c))) throw new Error(`CSV 需要包含：${required.join(", ")}`);
    const wide = false;
    const groups = new Map();
    const identities = new Map();
    for (const row of rows.slice(1)) {
      if (!row.some(v => String(v).trim())) continue;
      const get = c => String(row[headers.indexOf(c)] ?? "").trim();
      const times = ["start_epoch", "start_offset", "end_epoch", "end_offset"].map(c => {
        if (!get(c) || !Number.isFinite(Number(get(c)))) throw new Error(`非法时间字段：${c}`);
        return Number(get(c));
      });
      if (!Number.isInteger(times[0]) || !Number.isInteger(times[2]) || times[1] < 0 || times[3] < 0)
        throw new Error("epoch 必须是整数，offset 必须非负。");
      const eventType = type(get("type"));
      if (!get("dataset_name") || !get("image_name") || !get("annotation_id"))
        throw new Error("dataset_name、image_name 和 annotation_id 不能为空。");
      if (!Number.isFinite(Number(get("duration_s"))) || Number(get("duration_s")) <= 0)
        throw new Error("duration_s 必须是正数。");
      const key = JSON.stringify([get("dataset_name"), get("image_name"), eventType, ...times]);
      const id = get("annotation_id");
      const prior = identities.get(id);
      if (prior && prior !== key) throw new Error(`annotation_id ${id} 对应了不同的事件时间或类型。`);
      identities.set(id, key);
      const groupKey = JSON.stringify([key, id]);
      if (!groups.has(groupKey)) groups.set(groupKey, { eventId: id, eventType,
        datasetName: get("dataset_name"), recordingName: get("image_name"),
        startEpoch: times[0], startOffset: times[1], endEpoch: times[2], endOffset: times[3],
        durationS: Number(get("duration_s")), channels: [] });
      const event = groups.get(groupKey);
      let detected;
      if (wide) {
        for (const c of eegChannels) if (!["0", "1", "NA"].includes(get(c.toLowerCase()).toUpperCase()))
          throw new Error(`${c} 仅支持 1、0 或 NA。`);
        detected = eegChannels.filter(c => get(c.toLowerCase()) === "1");
      } else {
        if (!get("channel")) throw new Error("channel 不能为空。");
        detected = get("channel").split(";").map(channel);
      }
      const definition = eventDefinitions[eventType];
      for (const c of detected) {
        if (!definition.allowed.includes(c)) throw new Error(`${definition.csvType} 不允许通道 ${c}。`);
        if (!event.channels.includes(c)) event.channels.push(c);
      }
    }
    return [...groups.values()];
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
  root.EventGeometry = { channels: eegChannels, eegChannels, eventDefinitions, channel, type, readRows, project };
  if (typeof module !== "undefined") module.exports = root.EventGeometry;
})(globalThis);
