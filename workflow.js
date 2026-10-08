(function () {
  "use strict";

  const byId = (id) => document.getElementById(id);
  const dialog = byId("projectWorkflowDialog");
  let project = window.__EEG_SERVER_BOOTSTRAP__?.config?.projectContext ? null : { project: null };

  async function api(path, payload) {
    const options = payload === undefined ? {} : {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-EEG-Token": window.__EEG_SERVER_BOOTSTRAP__.token },
      body: JSON.stringify(payload),
    };
    const response = await fetch(path, options);
    const result = await response.json();
    if (!response.ok || result.error) throw new Error(result.error || `HTTP ${response.status}`);
    return result;
  }

  function context() {
    return project?.context ?? window.__EEG_SERVER_BOOTSTRAP__?.config?.projectContext ?? null;
  }

  function status(message, isError = false) {
    byId("wfStatus").textContent = message;
    byId("wfStatus").classList.toggle("error", isError);
  }

  async function refresh() {
    project = await api("api/project");
    const opened = Boolean(project.project);
    byId("projectImageSetsDirInput").value = opened ? project.paths.image_sets_dir : "";
    byId("projectDirInput").value = opened ? project.configPath.replace(/[\\/]project\.json$/, "") : "";
    byId("wfVersionSection").hidden = !opened;

    const select = byId("wfVersions");
    select.replaceChildren();
    for (const item of project.imageSets || []) {
      const option = document.createElement("option");
      option.value = item.id;
      option.textContent = [item.id, item.datasetName, item.recordingName].filter(Boolean).join(" | ");
      option.selected = item.id === project.project.active_image_set;
      select.append(option);
    }
    byId("wfActivate").disabled = !select.options.length;
    return project;
  }

  function showMode(mode) {
    byId("wfCreateSection").hidden = mode !== "create";
    byId("wfOpenSection").hidden = mode !== "open";
    status("");
    if (!dialog.open) dialog.showModal();
  }

  async function run(action) {
    try { await action(); }
    catch (error) { status(error.message, true); }
  }

  async function reloadApplication(message) {
    status(message);
    window.setTimeout(() => window.location.reload(), 180);
  }

  async function browse(initial, title) {
    const result = await api("api/select-directory", { initial, title });
    return result.path || "";
  }

  byId("projectCreateBtn").addEventListener("click", () => run(async () => {
    await refresh();
    showMode("create");
  }));
  byId("projectOpenBtn").addEventListener("click", () => run(async () => {
    await refresh();
    showMode("open");
  }));
  byId("loadWaveImagesBtn").addEventListener("click", () => run(async () => {
    await refresh();
    showMode(project?.project ? "load" : "open");
    byId("wfCreateSection").hidden = true;
    byId("wfOpenSection").hidden = Boolean(project?.project);
  }));
  byId("closeWorkflowBtn").addEventListener("click", () => dialog.close());

  byId("wfCreate").addEventListener("click", () => run(async () => {
    project = await api("api/project/create", {
      context: context(),
      image_sets_dir: byId("wfImageSets").value.trim(),
      project_dir: byId("wfProject").value.trim(),
      annotations_dir: byId("wfAnnotations").value.trim(),
    });
    await reloadApplication("项目已创建。正在加载当前底图...");
  }));

  byId("wfOpen").addEventListener("click", () => run(async () => {
    project = await api("api/project/open", { context: context(), path: byId("wfOpenProject").value.trim() });
    await reloadApplication("项目已打开。正在加载...");
  }));

  byId("wfActivate").addEventListener("click", () => run(async () => {
    const imageSet = byId("wfVersions").value;
    if (!imageSet) throw new Error("外部图片库中没有可加载的 images_manifest.json");
    project = await api("api/project/activate", { context: context(), imageSet });
    await reloadApplication("底图已加载。正在刷新标注界面...");
  }));

  document.querySelectorAll("[data-browse]").forEach((button) => {
    button.addEventListener("click", () => run(async () => {
      const target = byId(button.dataset.browse);
      const chosen = await browse(target.value, "选择文件夹");
      if (chosen) target.value = chosen;
    }));
  });

  run(refresh);
})();
