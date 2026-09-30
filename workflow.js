/* Project controls are separate from annotation geometry and detector code. */
(function () {
  const byId = id => document.getElementById(id);
  const dialog = byId("projectWorkflowDialog");
  const status = byId("wfStatus");
  const pageContext = window.__EEG_SERVER_BOOTSTRAP__?.config?.projectContext || null;
  let project = null, timer = null, autoLoad = false, directoryTarget = null, directory = null;
  function closeTopbarMenus() {
    document.querySelectorAll(".topbar details[open]").forEach(details => { details.open = false; });
  }

  async function api(path, payload) {
    const response = await fetch(path, payload === undefined ? { cache: "no-store" } : {
      method: "POST", headers: { "Content-Type": "application/json",
        "X-EEG-Token": window.__EEG_SERVER_BOOTSTRAP__?.token || "" },
      body: JSON.stringify({ ...payload, context: pageContext })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || response.statusText);
    return data;
  }
  async function run(action) {
    try { await action(); }
    catch (error) { status.textContent = error.message; }
  }
  async function flush() { await window.eegWorkflow.flush(); }
  function projectDirectory(configPath) {
    return String(configPath || "").replace(/[\\/]project\.json$/, "");
  }
  function setDialogMode(mode) {
    byId("wfCreateSection").hidden = mode !== "create";
    byId("wfOpenSection").hidden = mode !== "open";
    byId("wfGenerateSection").hidden = mode !== "generate";
    byId("wfVersionSection").hidden = mode !== "load";
    dialog.dataset.mode = mode;
    dialog.querySelector("h2").textContent = ({
      create: "创建项目",
      open: "打开项目",
      generate: "生成无标注底图",
      load: "加载无标注底图",
    })[mode] || "标注项目";
  }
  async function openDialog(mode) {
    closeTopbarMenus();
    setDialogMode(mode);
    dialog.showModal();
    if (location.protocol === "file:") throw new Error("请用 python server.py 启动后访问本机网页。");
    await refresh();
  }
  async function refresh() {
    project = await api("api/project");
    byId("projectEdfDirInput").value = project.project ? project.paths.edf_dir : "";
    byId("projectDirInput").value = project.project ? projectDirectory(project.configPath) : "";
    byId("wfGenerate").disabled = !project.project;
    if (project.project) {
      byId("wfEdf").value = project.paths.edf_dir;
      byId("wfProject").value = projectDirectory(project.configPath);
      byId("wfOpenProject").value = projectDirectory(project.configPath);
      byId("wfRecording").value = project.project.recording_id;
      const specification = project.generationOptions;
      if (specification) {
        const options = specification.options;
        byId("wfChannels").value = specification.channels.join(" ");
        for (const [id, key] of [["wfDataset", "dataset_name"], ["wfRecording", "recording_name"],
          ["wfEpoch", "epoch_length_sec"], ["wfBase", "epoch_base"], ["wfStart", "start_epoch"],
          ["wfEnd", "end_epoch"], ["wfAmplitude", "amplitude_uv"], ["wfDpi", "dpi"]])
          byId(id).value = options[key] ?? "";
        byId("wfBandLow").value = options.display_band?.[0] ?? "";
        byId("wfBandHigh").value = options.display_band?.[1] ?? "";
      }
    }
    byId("wfVersions").replaceChildren(...(project.generations || []).map(name => {
      const option = document.createElement("option"); option.value = name; option.textContent = name;
      option.selected = name === project.project?.active_generation; return option;
    }));
    await poll();
  }
  async function activate(generation) {
    await flush();
    await api("api/project/activate", { generation });
    location.reload();
  }
  async function poll() {
    clearTimeout(timer);
    const job = await api("api/job");
    const running = job.state === "running";
    byId("wfGenerate").disabled = running || !project?.project;
    byId("wfCancel").disabled = !running;
    byId("wfCreate").disabled = running;
    byId("wfOpen").disabled = running;
    byId("wfActivate").disabled = running || !project?.generations?.length;
    if (job.state === "idle") return;
    status.textContent = `${job.state}: ${job.message || ""}${job.total ? ` (${job.completed}/${job.total})` : ""}${job.log ? ` · 日志：${job.log}` : ""}`;
    const progress = byId("wfProgress");
    if (running && !job.total) progress.removeAttribute("value");
    else progress.value = job.state === "complete" ? 100 : job.total ? 100 * job.completed / job.total : 0;
    if (running) timer = setTimeout(() => run(poll), 1200);
    else if (job.state === "complete" && job.generation && (autoLoad || dialog.dataset.mode === "generate")) {
      autoLoad = false;
      status.textContent = "生成完成，正在加载无标注底图...";
      await activate(job.generation);
    }
  }
  byId("projectCreateBtn").addEventListener("click", () => run(() => openDialog("create")));
  byId("projectOpenBtn").addEventListener("click", () => run(() => openDialog("open")));
  byId("generateWaveImagesBtn").addEventListener("click", () => run(() => openDialog("generate")));
  byId("loadWaveImagesBtn").addEventListener("click", () => run(() => openDialog("load")));
  byId("closeWorkflowBtn").addEventListener("click", () => dialog.close());
  byId("wfCreate").addEventListener("click", () => run(async () => {
    if (!byId("wfEdf").value.trim() || !byId("wfProject").value.trim()) throw new Error("请选择 EDF 与项目目录。");
    await flush();
    await api("api/project/create", { edf_dir: byId("wfEdf").value.trim(), project_dir: byId("wfProject").value.trim(),
      images_dir: byId("wfImages").value.trim(), annotations_dir: byId("wfAnnotations").value.trim(),
      cache_dir: byId("wfCache").value.trim(), logs_dir: byId("wfLogs").value.trim() });
    location.reload();
  }));
  byId("wfOpen").addEventListener("click", () => run(async () => {
    if (!byId("wfOpenProject").value.trim()) throw new Error("请选择已有项目目录，或填写 project.json 路径。");
    await flush();
    await api("api/project/open", { path: byId("wfOpenProject").value.trim() });
    location.reload();
  }));
  byId("wfGenerate").addEventListener("click", () => run(async () => {
    const number = id => byId(id).value.trim() === "" ? null : Number(byId(id).value);
    const bandLow = number("wfBandLow");
    const bandHigh = number("wfBandHigh");
    const displayBand = bandLow === null && bandHigh === null ? null : [bandLow, bandHigh];
    if (displayBand && (!Number.isFinite(displayBand[0]) || !Number.isFinite(displayBand[1]) || displayBand[0] >= displayBand[1])) {
      throw new Error("显示频带需要同时填写有效的低频和高频，且低频必须小于高频。");
    }
    const job = await api("api/job/start", { options: {
      channels: byId("wfChannels").value.trim().split(/[\s,;]+/),
      dataset_name: byId("wfDataset").value.trim(), recording_name: byId("wfRecording").value.trim(),
      epoch_length_sec: number("wfEpoch"), epoch_base: number("wfBase"),
      start_epoch: number("wfStart"), end_epoch: number("wfEnd"), dpi: number("wfDpi"),
      amplitude_uv: number("wfAmplitude"), display_band: displayBand
    }});
    autoLoad = job.state === "running" || job.state === "complete";
    await poll();
  }));
  byId("wfCancel").addEventListener("click", () => run(async () => {
    autoLoad = false; await api("api/job/cancel", {}); await poll();
  }));
  byId("wfActivate").addEventListener("click", () => run(() => activate(byId("wfVersions").value)));

  async function selectDirectory(input) {
    try {
      const data = await api("api/select-directory", { initial: input.value.trim(), title: "选择文件夹" });
      if (data.path) input.value = data.path;
    } catch (error) {
      directoryTarget = input;
      byId("directoryDialog").showModal();
      await browse(input.value.trim());
    }
  }

  async function browse(path) {
    try {
      directory = await api("api/directories?path=" + encodeURIComponent(path));
      byId("directoryPath").value = directory.path || "选择磁盘";
      byId("directoryChoose").disabled = !directory.path;
      byId("directoryList").replaceChildren(...directory.directories.map(name => {
        const button = document.createElement("button"); button.type = "button";
        button.textContent = name; button.addEventListener("click", () => browse(name)); return button;
      }));
    } catch (error) { byId("directoryPath").value = error.message; }
  }
  document.querySelectorAll("[data-browse]").forEach(button => button.addEventListener("click", () => {
    run(() => selectDirectory(byId(button.dataset.browse)));
  }));
  byId("directoryUp").addEventListener("click", () => browse(directory?.parent === directory?.path ? "" : directory?.parent || ""));
  byId("directoryChoose").addEventListener("click", () => {
    if (directory?.path) directoryTarget.value = directory.path;
    byId("directoryDialog").close();
  });
  byId("directoryClose").addEventListener("click", () => byId("directoryDialog").close());
  run(refresh);
})();
