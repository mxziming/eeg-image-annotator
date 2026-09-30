(function () {
  const PROJECT_CONTEXT = window.__EEG_SERVER_BOOTSTRAP__?.config?.projectContext;
  const STORAGE_KEY = "eeg-image-annotator-state-v1" + (PROJECT_CONTEXT ? ":" + PROJECT_CONTEXT : "");
  const DB_NAME = "eeg-image-annotator-db";
  const DB_VERSION = 1;
  const IMAGE_STORE = "images";
  const OVERLAP_THRESHOLD = 0.5;

  const DEFAULT_LAYOUT = {
    plotLeftPct: 3.0,
    plotRightPct: 98.35,
    channels: [
      { name: "EEG F3-CLE", topPct: 4.45, bottomPct: 24.85 },
      { name: "EEG F4-CLE", topPct: 27.58, bottomPct: 47.98 },
      { name: "EEG C3-CLE", topPct: 50.75, bottomPct: 71.1 },
      { name: "EEG C4-CLE", topPct: 73.85, bottomPct: 94.25 }
    ]
  };

  const EVENT_LABELS = {
    k_complex: "K波",
    spindle: "纺锤波", micro_arousal: "微觉醒"
  };
  const CSV_EVENT_TYPES = {
    k_complex: "k-complex",
    spindle: "spindle", micro_arousal: "micro-arousal"
  };
  const INTERNAL_EVENT_TYPES = {
    k: "k_complex", s: "spindle", a: "micro_arousal",
    arousal: "micro_arousal", "micro-arousal": "micro_arousal", micro_arousal: "micro_arousal",
    "k-complex": "k_complex",
    k_complex: "k_complex",
    spindle: "spindle"
  };
  const CSV_CHANNEL_ALIASES = new Map([
    ["F3CLE", "F3M2"],
    ["F3M2", "F3M2"],
    ["F4CLE", "F4M1"],
    ["F4M1", "F4M1"],
    ["C3CLE", "C3M2"],
    ["C3M2", "C3M2"],
    ["C4CLE", "C4M1"],
    ["C4M1", "C4M1"],
    ["O1CLE", "O1M2"],
    ["O1M2", "O1M2"],
    ["O2CLE", "O2M1"],
    ["O2M1", "O2M1"]
  ]);
  const els = {
    datasetNameInput: document.getElementById("datasetNameInput"),
    csvImportBtn: document.getElementById("csvImportBtn"),
    csvInput: document.getElementById("csvInput"),
    csvImportDialog: document.getElementById("csvImportDialog"),
    cancelCsvImportBtn: document.getElementById("cancelCsvImportBtn"),
    continueCsvImportBtn: document.getElementById("continueCsvImportBtn"),
    taskDialog: document.getElementById("taskDialog"),
    taskDialogTitle: document.getElementById("taskDialogTitle"),
    taskDialogStatus: document.getElementById("taskDialogStatus"),
    taskDialogProgress: document.getElementById("taskDialogProgress"),
    taskDialogDetail: document.getElementById("taskDialogDetail"),
    taskDialogConfirmBtn: document.getElementById("taskDialogConfirmBtn"),
    saveDatasetBtn: document.getElementById("saveDatasetBtn"),
    exportCsvBtn: document.getElementById("exportCsvBtn"),
    serverStatus: document.getElementById("serverStatus"),
    saveStatus: document.getElementById("saveStatus"),
    imageList: document.getElementById("imageList"),
    imageTotal: document.getElementById("imageTotal"),
    epochSearchInput: document.getElementById("epochSearchInput"),
    imageFilterButtons: document.querySelectorAll("[data-image-filter]"),
    currentEpochLabel: document.getElementById("currentEpochLabel"),
    currentImagePosition: document.getElementById("currentImagePosition"),
    currentImageName: document.getElementById("currentImageName"),
    eventTypeSelect: document.getElementById("eventTypeSelect"),
    windowStartInput: document.getElementById("windowStartInput"),
    windowDurationSelect: document.getElementById("windowDurationSelect"),
    deleteAnnotationBtn: document.getElementById("deleteAnnotationBtn"),
    prevImageBtn: document.getElementById("prevImageBtn"),
    nextImageBtn: document.getElementById("nextImageBtn"),
    emptyState: document.getElementById("emptyState"),
    viewerScroll: document.querySelector(".viewer-scroll"),
    viewer: document.getElementById("viewer"),
    eegImage: document.getElementById("eegImage"),
    overlay: document.getElementById("overlay"),
    selectionDetails: document.getElementById("selectionDetails"),
    plotLeftInput: document.getElementById("plotLeftInput"),
    plotRightInput: document.getElementById("plotRightInput"),
    calibrationStatus: document.getElementById("calibrationStatus"),
    channelConfig: document.getElementById("channelConfig"),
    resetCalibrationBtn: document.getElementById("resetCalibrationBtn"),
    currentAnnotationCount: document.getElementById("currentAnnotationCount"),
    currentAnnotationTable: document.getElementById("currentAnnotationTable"),
    annotationCount: document.getElementById("annotationCount"),
    annotationTable: document.getElementById("annotationTable")
  };

  const state = {
    datasetName: "eeg-image-annotations",
    currentImageId: null,
    selectedAnnotationId: null,
    activeEventType: "k_complex",
    imageSearch: "",
    imageFilter: "all",
    layoutPreset: cloneLayout(DEFAULT_LAYOUT),
    defaultWindowDuration: 30,
    unmatchedReferences: [],
    images: [],
    imageUrls: new Map(),
    api: {
      available: false,
      config: null
    },
    db: null,
    drag: null,
    calibrationTarget: null,
    resizeObserver: null
  };

  let projectSaveQueue = Promise.resolve();
  let projectSaveError = null;
  let initialized = false;
  window.eegWorkflow = { flush: async () => {
    if (!initialized) throw new Error("界面尚在加载，请稍后重试。");
    clearTimeout(saveTimer);
    persistNow();
    await projectSaveQueue;
    if (projectSaveError) throw projectSaveError;
  }};
  init();

  async function init() {
    state.db = await openDatabase().catch((error) => {
      console.warn("IndexedDB unavailable; image blobs will not persist.", error);
      els.saveStatus.textContent = "浏览器图片持久化不可用；建议通过本地服务器打开。";
      return null;
    });
    loadState();
    bindEvents();
    renderChannelConfig();
    if (window.location.protocol !== "file:") {
      await loadServerDataset({ silent: true });
      if (!state.api.available) {
        await hydrateImageUrls();
        if (!state.currentImageId && state.images.length) {
          state.currentImageId = state.images[0].id;
        }
        render();
      }
    } else {
      await hydrateImageUrls();
      if (!state.currentImageId && state.images.length) {
        state.currentImageId = state.images[0].id;
      }
      render();
    }
    initialized = true;
  }

  function bindEvents() {
    els.datasetNameInput.addEventListener("input", () => {
      state.datasetName = els.datasetNameInput.value.trim() || "eeg-image-annotations";
      persistSoon("数据集名称已更新。");
    });

    document.getElementById("applyCalibrationBtn").addEventListener("click", () => {
      const image = getCurrentImage();
      if (!image) return;
      const layout = image.layout;
      if (!(layout.plotRightPct > layout.plotLeftPct) || !layout.channels.length ||
          layout.channels.some(c => !(c.bottomPct > c.topPct))) {
        window.alert("请检查左右边界，以及每条通道的上下边界。"); return;
      }
      layout.calibrated = true;
      rememberLayoutPreset(image);
      persistSoon("校准已确认，后续调整边界会实时更新标注框。");
      renderAnnotationsOnly();
    });

    document.getElementById("configureChannelsBtn").addEventListener("click", () => {
      const image = getCurrentImage();
      const layout = image ? image.layout : state.layoutPreset;
      const answer = window.prompt("按图片从上到下输入通道名，用逗号分隔：",
        layout.channels.map(c => toCsvChannelName(c.name)).join(","));
      if (answer === null) return;
      const names = answer.split(/[,，;]/).map(v => EventGeometry.channel(v.trim())).filter(Boolean);
      if (!names.length || new Set(names).size !== names.length) {
        window.alert("请输入至少一条通道，名称不能重复。"); return;
      }
      layout.channels = names.map((name, i) => {
        const existing = layout.channels.find(c => EventGeometry.channel(c.name) === name);
        return existing || { name, topPct: 5 + i * 90 / names.length,
          bottomPct: 5 + (i + 1) * 90 / names.length - 2 };
      });
      layout.calibrated = false;
      if (image) rememberLayoutPreset(image);
      else state.layoutPreset = cloneLayout(layout);
      persistSoon("通道已设置，请点选每条通道的上下边界。");
      render();
    });

    els.csvImportBtn.addEventListener("click", () => {
      openCsvImportDialog();
    });

    els.cancelCsvImportBtn.addEventListener("click", () => {
      els.csvImportDialog.close("cancel");
    });

    els.continueCsvImportBtn.addEventListener("click", () => {
      els.csvImportDialog.close("continue");
      closeTopbarMenus();
      els.csvInput.click();
    });

    els.taskDialogConfirmBtn.addEventListener("click", () => {
      if (!els.taskDialogConfirmBtn.disabled) els.taskDialog.close();
    });
    els.taskDialog.addEventListener("cancel", (event) => {
      event.preventDefault();
    });

    els.csvInput.addEventListener("change", async (event) => {
      const file = event.target.files && event.target.files[0];
      if (!file) return;
      closeTopbarMenus();
      await runTask("加载参考框", "正在读取 CSV 文件...", () => importCsv(file));
      event.target.value = "";
    });

    els.saveDatasetBtn.addEventListener("click", async () => {
      closeTopbarMenus();
      await runTask("保存当前进度", "正在整理数据集状态...", async () => {
        updateTaskProgress(45, PROJECT_CONTEXT ? "正在写入项目标注文件..." : "正在写入浏览器本地存储...");
        await waitForNextPaint();
        await window.eegWorkflow.flush();
        return { message: "当前进度已保存。" };
      });
    });
    els.exportCsvBtn.addEventListener("click", async () => {
      closeTopbarMenus();
      await runTask("导出 CSV", "正在生成标注表...", exportCsv);
    });
    els.epochSearchInput.addEventListener("input", () => {
      state.imageSearch = els.epochSearchInput.value.trim().toLowerCase();
      renderImageList();
    });
    els.imageFilterButtons.forEach((button) => {
      button.addEventListener("click", () => {
        state.imageFilter = button.dataset.imageFilter;
        renderImageList();
      });
    });

    els.eventTypeSelect.addEventListener("change", () => {
      state.activeEventType = normalizeEventType(els.eventTypeSelect.value);
      state.selectedAnnotationId = null;
      state.drag = null;
      persistNow(`已切换到${EVENT_LABELS[state.activeEventType]}标注。`);
      renderImageList();
      renderAnnotationsOnly();
    });

    els.windowStartInput.addEventListener("input", () => {
      const image = getCurrentImage();
      if (!image) return;
      image.windowStart = parseFloatOrZero(els.windowStartInput.value);
      persistSoon("窗口起点已更新。");
      renderAnnotationsOnly();
    });

    els.windowDurationSelect.addEventListener("change", () => {
      state.defaultWindowDuration = Number(els.windowDurationSelect.value);
      state.images.forEach((image) => {
        image.windowDuration = state.defaultWindowDuration;
      });
      persistSoon("窗口长度已更新，并会作为之后图片的默认值。");
      renderAnnotationsOnly();
    });

    els.deleteAnnotationBtn.addEventListener("click", deleteSelectedAnnotation);
    els.prevImageBtn.addEventListener("click", () => moveCurrentImage(-1));
    els.nextImageBtn.addEventListener("click", () => moveCurrentImage(1));
    els.resetCalibrationBtn.addEventListener("click", resetCalibration);

    els.plotLeftInput.addEventListener("input", () => updateLayoutValue("plotLeftPct", els.plotLeftInput.value));
    els.plotRightInput.addEventListener("input", () => updateLayoutValue("plotRightPct", els.plotRightInput.value));
    document.querySelectorAll("[data-calibration-target]").forEach((button) => {
      button.addEventListener("click", () => setCalibrationTarget(button.dataset.calibrationTarget));
    });

    els.overlay.addEventListener("pointerdown", startDrag);
    els.overlay.addEventListener("pointermove", moveDrag);
    els.overlay.addEventListener("pointerup", endDrag);
    els.overlay.addEventListener("pointercancel", cancelDrag);

    document.addEventListener("keydown", (event) => {
      const tag = document.activeElement && document.activeElement.tagName;
      if (["INPUT", "TEXTAREA", "SELECT"].includes(tag) || els.csvImportDialog.open || els.taskDialog.open || state.drag || event.altKey || event.ctrlKey || event.metaKey) return;
      if (event.key === "Delete" || event.key === "Backspace") deleteSelectedAnnotation();
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        moveCurrentImage(-1);
      }
      if (event.key === "ArrowRight") {
        event.preventDefault();
        moveCurrentImage(1);
      }
    });
    document.addEventListener("click", (event) => {
      if (!event.target.closest(".topbar-menus")) {
        closeTopbarMenus();
      }
    });

    window.addEventListener("resize", fitViewerToStage);
    if (window.ResizeObserver && els.viewerScroll) {
      state.resizeObserver = new ResizeObserver(() => fitViewerToStage());
      state.resizeObserver.observe(els.viewerScroll);
    }
  }

  function closeTopbarMenus() {
    document.querySelectorAll(".topbar-menus details[open]").forEach((menu) => {
      menu.removeAttribute("open");
    });
  }

  async function runTask(title, initialStatus, operation) {
    openTaskDialog(title, initialStatus);
    await waitForNextPaint();
    try {
      const result = await operation();
      const message = result && result.message ? result.message : "操作已完成。";
      const detail = result && result.detail ? result.detail : "";
      finishTask(message, detail);
      return result;
    } catch (error) {
      failTask(error);
      return null;
    }
  }

  function openTaskDialog(title, status) {
    if (!els.taskDialog) return;
    els.taskDialog.dataset.state = "running";
    els.taskDialogTitle.textContent = title;
    els.taskDialogStatus.textContent = status;
    els.taskDialogDetail.textContent = "";
    els.taskDialogProgress.value = 0;
    els.taskDialogConfirmBtn.disabled = true;
    els.taskDialogConfirmBtn.hidden = true;
    if (!els.taskDialog.open && typeof els.taskDialog.showModal === "function") {
      els.taskDialog.showModal();
    }
  }

  function updateTaskProgress(value, status, detail = "") {
    if (!els.taskDialog || !els.taskDialog.open) return;
    if (Number.isFinite(value)) {
      els.taskDialogProgress.value = clamp(value, 0, 100);
    } else {
      els.taskDialogProgress.removeAttribute("value");
    }
    if (status) els.taskDialogStatus.textContent = status;
    els.taskDialogDetail.textContent = detail;
  }

  function finishTask(status, detail = "") {
    if (!els.taskDialog) return;
    els.taskDialog.dataset.state = "complete";
    els.taskDialogProgress.value = 100;
    els.taskDialogStatus.textContent = status;
    els.taskDialogDetail.textContent = detail;
    els.taskDialogConfirmBtn.disabled = false;
    els.taskDialogConfirmBtn.hidden = false;
    els.taskDialogConfirmBtn.focus();
  }

  function failTask(error) {
    if (!els.taskDialog) return;
    const message = error && error.message ? error.message : String(error || "未知错误");
    els.taskDialog.dataset.state = "error";
    els.taskDialogProgress.value = 100;
    els.taskDialogStatus.textContent = "操作未完成";
    els.taskDialogDetail.textContent = message;
    els.taskDialogConfirmBtn.disabled = false;
    els.taskDialogConfirmBtn.hidden = false;
    els.taskDialogConfirmBtn.focus();
  }

  function waitForNextPaint() {
    if (typeof requestAnimationFrame !== "function") return Promise.resolve();
    return new Promise((resolve) => requestAnimationFrame(() => resolve()));
  }

  function openCsvImportDialog() {
    if (els.csvImportDialog && typeof els.csvImportDialog.showModal === "function") {
      els.csvImportDialog.showModal();
      return;
    }
    const confirmed = window.confirm(
      "CSV 参考框会根据当前图片的左端、右端和通道位置重建。请确认这些校准位置准确，否则导入框的位置可能偏移。是否继续导入？"
    );
    if (confirmed) {
      closeTopbarMenus();
      els.csvInput.click();
    }
  }

  async function loadServerDataset(options = {}) {
    try {
      if (!options.silent) {
        els.serverStatus.textContent = "正在连接本地服务并读取 E盘图片...";
      }
      if (window.location.protocol === "file:") {
        throw new Error("当前页面是 file:// 直接打开的，不能连接本地服务。请先运行 python server.py，然后访问 http://localhost:8765。");
      }
      if (options.showProgress) updateTaskProgress(10, "正在读取默认目录配置...");
      const config = await requestJson("api/config");
      if (options.showProgress) updateTaskProgress(30, "正在获取图片清单...", config.imageDir || "");
      const payload = await requestJson("api/images");
      const serverImages = Array.isArray(payload.images) ? payload.images : [];
      const manifest = config.manifest;
      const metadata = new Map((manifest?.images || []).map(item => [item.name, item]));
      if (manifest && !state.images.length) {
        state.layoutPreset = { plotLeftPct: 6.5, plotRightPct: 99, calibrated: false,
          channels: manifest.channels.map((name, index) => ({ name,
            topPct: 5 + index * 90 / manifest.channels.length,
            bottomPct: 5 + (index + 1) * 90 / manifest.channels.length })) };
        state.defaultWindowDuration = manifest.epochLengthSec;
        renderChannelConfig();
      }
      const existingById = new Map(state.images.map((image) => [image.id, image]));
      const existingByName = new Map(state.images.map((image) => [image.name, image]));

      state.api.available = true;
      state.api.config = config;
      state.datasetName = config.datasetName || "SouthData_39";
      const inferredDuration = inferWindowDurationFromImages(serverImages);
      if (inferredDuration) {
        state.defaultWindowDuration = inferredDuration;
      }

      const loadedImages = [];
      for (let index = 0; index < serverImages.length; index += 1) {
        const item = serverImages[index];
        const existing = existingById.get(item.id) || existingByName.get(item.name);
        const meta = metadata.get(item.name);
        const record = {
          recordingName: existing?.recordingName,
          datasetName: existing?.datasetName,
          epoch: existing?.epoch,
          epochBase: existing?.epochBase,
          epochLengthSec: existing?.epochLengthSec,
          id: item.id,
          source: "server",
          serverId: item.id,
          name: item.name,
          relativePath: item.relativePath || item.name,
          type: item.type || "",
          size: item.size || 0,
          naturalWidth: existing ? existing.naturalWidth : null,
          naturalHeight: existing ? existing.naturalHeight : null,
          addedAt: existing ? existing.addedAt : new Date().toISOString(),
          windowStart: existing?.windowStart ?? parseStartTimeFromName(item.relativePath || item.name),
          windowDuration: existing?.windowDuration || state.defaultWindowDuration,
          layout: cloneLayout(state.layoutPreset),
          annotations: existing && Array.isArray(existing.annotations) ? existing.annotations : []
        };
        if (meta) Object.assign(record, { recordingName: meta.recordingName, datasetName: meta.datasetName,
          epoch: meta.epoch, epochBase: manifest.epochBase, epochLengthSec: manifest.epochLengthSec,
          windowStart: meta.windowStart, windowDuration: meta.windowDuration });
        state.imageUrls.set(record.id, `api/image/${encodeURIComponent(record.serverId)}`);
        loadedImages.push(record);
        if (options.showProgress && (index % 50 === 0 || index === serverImages.length - 1)) {
          const completed = index + 1;
          const progress = 35 + Math.round((completed / Math.max(serverImages.length, 1)) * 55);
          updateTaskProgress(progress, `正在建立图片索引 ${completed} / ${serverImages.length}`, item.relativePath || item.name);
          await waitForNextPaint();
        }
      }
      state.images = loadedImages;
      importLegacyReferences(state.unmatchedReferences);

      if (!state.images.some((image) => image.id === state.currentImageId)) {
        state.currentImageId = state.images[0] ? state.images[0].id : null;
      }
      state.selectedAnnotationId = null;
      els.exportCsvBtn.textContent = "导出CSV标注";
      els.serverStatus.textContent = serverImages.length
        ? `已连接并找到 ${serverImages.length} 张图片：${config.imageDir} -> ${config.csvPath}`
        : `已连接，但目录中没有找到图片：${config.imageDir}。支持 png/jpg/jpeg/webp/bmp/gif/tif/tiff。`;
      persistNow(options.silent ? "" : `已载入 ${state.images.length} 张 E盘图片。`);
      render();
      return {
        message: `已从默认目录载入 ${state.images.length} 张图片。`,
        detail: config.imageDir || ""
      };
    } catch (error) {
      state.api.available = false;
      state.api.config = null;
      els.exportCsvBtn.textContent = "导出CSV标注";
      els.serverStatus.textContent = `本地服务未连接：${error.message}`;
      if (!options.silent) throw error;
      return null;
    }
  }

  function parseStartTimeFromName(name) {
    const patterns = [
      /start[_-]?(\d+)p(\d+)s/i,
      /(?:start|time|t)[_-]?(\d+(?:\.\d+)?)s?/i,
      /(?:^|[_-])(\d+(?:\.\d+)?)s(?:[_\-.]|$)/i
    ];
    for (const pattern of patterns) {
      const match = name.match(pattern);
      if (match) return Number(match[2] ? `${match[1]}.${match[2]}` : match[1]);
    }
    return 0;
  }

  function inferWindowDurationFromImages(images) {
    const points = images
      .map((image) => ({
        epoch: parseEpochIndexFromText(`${image.relativePath || ""} ${image.name || ""}`),
        start: parseStartTimeFromName(image.relativePath || image.name || "")
      }))
      .filter((point) => Number.isFinite(point.epoch) && Number.isFinite(point.start))
      .sort((a, b) => a.epoch - b.epoch);

    const counts = new Map();
    for (let index = 1; index < points.length; index += 1) {
      const previous = points[index - 1];
      const current = points[index];
      const epochDelta = current.epoch - previous.epoch;
      const timeDelta = current.start - previous.start;
      if (epochDelta <= 0 || timeDelta <= 0) continue;
      const duration = Math.round((timeDelta / epochDelta) * 1000) / 1000;
      if (duration < 1 || duration > 120) continue;
      counts.set(duration, (counts.get(duration) || 0) + 1);
    }

    let bestDuration = null;
    let bestCount = 0;
    counts.forEach((count, duration) => {
      if (count > bestCount) {
        bestDuration = duration;
        bestCount = count;
      }
    });
    return bestDuration;
  }

  function getEpochIndex(image) {
    const source = `${image.relativePath || ""} ${image.name || ""} ${image.serverId || ""}`;
    const parsed = parseEpochIndexFromText(source);
    if (Number.isFinite(parsed)) return String(parsed);
    const index = state.images.findIndex((item) => item.id === image.id);
    return index >= 0 ? String(index + 1) : "";
  }

  function parseEpochIndexFromText(text) {
    const source = String(text || "");
    const patterns = [
      /epoch[_\s-]*(\d+)/i,
      /(?:^|[_\s-])ep[_\s-]*(\d+)(?:[_\s.-]|$)/i
    ];
    for (const pattern of patterns) {
      const match = source.match(pattern);
      if (match) return Number.parseInt(match[1], 10);
    }
    return null;
  }

  function getEpochIndexNumber(image) {
    if (Number.isInteger(image.epoch)) return image.epoch;
    const parsed = Number.parseInt(getEpochIndex(image), 10);
    if (Number.isFinite(parsed)) return parsed;
    const index = state.images.findIndex((item) => item.id === image.id);
    return index >= 0 ? index + 1 : 1;
  }

  function getEpochPositionForTime(image, absoluteTime) {
    const epochDuration = Math.max(Number(image.epochLengthSec || image.windowDuration || state.defaultWindowDuration || 30), 1);
    const imageEpoch = getEpochIndexNumber(image);
    const delta = Math.floor((absoluteTime - Number(image.windowStart || 0)) / epochDuration);
    const epoch = imageEpoch + delta;
    const epochStart = Number(image.windowStart || 0) + delta * epochDuration;
    return {
      epoch,
      offset: absoluteTime - epochStart
    };
  }

  function getAbsoluteTimeFromEpochPosition(image, epochValue, offsetValue) {
    const epoch = Number(epochValue);
    const offset = Number(offsetValue);
    if (!Number.isFinite(epoch) || !Number.isFinite(offset)) return null;
    const epochDuration = Math.max(Number(image.epochLengthSec || image.windowDuration || state.defaultWindowDuration || 30), 1);
    const imageEpoch = getEpochIndexNumber(image);
    return Number(image.windowStart || 0) + (epoch - imageEpoch) * epochDuration + offset;
  }

  function toCsvChannelName(channelName) {
    const key = normalizeChannelKey(channelName);
    return CSV_CHANNEL_ALIASES.get(key) || channelName.replace(/^EEG\s+/i, "").replace(/-/g, "");
  }

  function normalizeChannelKey(channelName) {
    return String(channelName || "")
      .replace(/^EEG\s+/i, "")
      .replace(/[^A-Za-z0-9]/g, "")
      .toUpperCase();
  }

  function normalizeEventType(value) {
    const key = String(value || "").trim().toLowerCase();
    return INTERNAL_EVENT_TYPES[key] || key || "k_complex";
  }

  function getCurrentImage() {
    return state.images.find((image) => image.id === state.currentImageId) || null;
  }

  function getSelectedAnnotation() {
    const image = getCurrentImage();
    if (!image) return null;
    return getAnnotationsForActiveEvent(image)
      .find((annotation) => annotation.id === state.selectedAnnotationId) || null;
  }

  function getAnnotationsForActiveEvent(image) {
    if (!image || !Array.isArray(image.annotations)) return [];
    return image.annotations.filter((annotation) =>
      normalizeEventType(annotation.eventType) === state.activeEventType
    );
  }

  function render() {
    els.datasetNameInput.value = state.datasetName;
    els.eventTypeSelect.value = state.activeEventType;
    els.windowDurationSelect.value = String(state.defaultWindowDuration);
    renderImageList();
    renderStageHeading();
    renderCurrentImage();
    renderChannelConfig();
    renderAnnotationsOnly();
  }

  function renderImageList() {
    const previousScroll = els.imageList.scrollTop;
    els.imageList.innerHTML = "";
    els.imageTotal.textContent = String(state.images.length);
    els.imageFilterButtons.forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.imageFilter === state.imageFilter));
    });
    if (!state.images.length) {
      const empty = document.createElement("div");
      empty.className = "status-line";
      empty.textContent = "还没有图片。";
      els.imageList.appendChild(empty);
      return;
    }

    const numericSearch = /^\d+$/.test(state.imageSearch) ? Number(state.imageSearch) : null;
    const visibleImages = state.images.filter((image) => {
      const eventAnnotationCount = getAnnotationsForActiveEvent(image).length;
      if (state.imageFilter === "pending" && eventAnnotationCount) return false;
      if (state.imageFilter === "annotated" && !eventAnnotationCount) return false;
      if (!state.imageSearch) return true;
      return numericSearch !== null
        ? Number(getEpochIndex(image)) === numericSearch
        : image.name.toLowerCase().includes(state.imageSearch);
    });
    if (!visibleImages.length) {
      const empty = document.createElement("div");
      empty.className = "status-line";
      empty.textContent = "没有符合条件的图片。";
      els.imageList.appendChild(empty);
      return;
    }

    for (const image of visibleImages) {
      const eventAnnotationCount = getAnnotationsForActiveEvent(image).length;
      const button = document.createElement("button");
      button.type = "button";
      button.className = [
        "image-item",
        image.id === state.currentImageId ? "active" : "",
        eventAnnotationCount ? "has-annotations" : ""
      ].filter(Boolean).join(" ");
      button.title = image.name;
      if (image.id === state.currentImageId) button.setAttribute("aria-current", "true");
      button.addEventListener("click", () => {
        state.currentImageId = image.id;
        state.selectedAnnotationId = null;
        persistSoon("已切换图片。");
        render();
      });

      const name = document.createElement("div");
      name.className = "image-name";
      name.textContent = `Epoch ${getEpochIndex(image).padStart(5, "0")}`;

      const meta = document.createElement("div");
      meta.className = "image-meta";
      meta.textContent = `${formatSecond(Number(image.windowStart || 0))} s`;

      const count = document.createElement("span");
      count.className = "image-item-count";
      count.textContent = String(eventAnnotationCount);
      count.setAttribute("aria-label", `${eventAnnotationCount} 个${EVENT_LABELS[state.activeEventType]}框`);

      button.append(name, meta, count);
      els.imageList.appendChild(button);
    }
    els.imageList.scrollTop = previousScroll;
    const active = els.imageList.querySelector(".image-item.active");
    if (active) {
      const listRect = els.imageList.getBoundingClientRect();
      const activeRect = active.getBoundingClientRect();
      if (activeRect.top < listRect.top || activeRect.bottom > listRect.bottom) {
        active.scrollIntoView({ block: "nearest" });
      }
    }
  }

  function renderStageHeading() {
    const image = getCurrentImage();
    const position = image ? state.images.findIndex((item) => item.id === image.id) + 1 : 0;
    els.currentEpochLabel.textContent = image ? `Epoch ${getEpochIndex(image)}` : "尚未选择图片";
    els.currentImagePosition.textContent = image ? `${position} / ${state.images.length}` : "";
    els.currentImageName.textContent = image ? image.name : "";
    els.currentImageName.title = image ? image.name : "";
    els.prevImageBtn.disabled = position <= 1;
    els.nextImageBtn.disabled = !image || position >= state.images.length;
  }

  function updateAnnotationToolStates() {
    els.deleteAnnotationBtn.disabled = !getSelectedAnnotation();
  }

  function renderCurrentImage() {
    const image = getCurrentImage();
    if (!image) {
      els.emptyState.hidden = false;
      els.viewer.hidden = true;
      els.eegImage.removeAttribute("src");
      return;
    }

    const url = state.imageUrls.get(image.id);
    els.emptyState.hidden = true;
    els.viewer.hidden = false;
    els.windowStartInput.value = image.windowStart;
    const durationValue = String(image.windowDuration || state.defaultWindowDuration);
    if (![...els.windowDurationSelect.options].some(option => option.value === durationValue)) {
      const option = document.createElement("option");
      option.value = durationValue; option.textContent = durationValue;
      els.windowDurationSelect.append(option);
    }
    els.windowDurationSelect.value = durationValue;
    // Manifest time geometry belongs to the generated image, not calibration.
    els.windowDurationSelect.disabled = Boolean(image.epochLengthSec);
    els.windowStartInput.disabled = Boolean(image.epochLengthSec);
    els.eegImage.onload = () => {
      image.naturalWidth = els.eegImage.naturalWidth;
      image.naturalHeight = els.eegImage.naturalHeight;
      els.overlay.setAttribute("viewBox", `0 0 ${els.eegImage.naturalWidth} ${els.eegImage.naturalHeight}`);
      fitViewerToStage();
      persistSoon();
      renderAnnotationsOnly();
    };
    if (els.eegImage.getAttribute("src") !== (url || "")) {
      els.eegImage.src = url || "";
    }

    if (els.eegImage.complete && els.eegImage.naturalWidth) {
      els.overlay.setAttribute("viewBox", `0 0 ${els.eegImage.naturalWidth} ${els.eegImage.naturalHeight}`);
      fitViewerToStage();
    }
  }

  function fitViewerToStage() {
    const image = getCurrentImage();
    if (!image || !els.viewerScroll || !els.eegImage.naturalWidth || els.viewer.hidden) return;

    const containerWidth = els.viewerScroll.clientWidth;
    const containerHeight = els.viewerScroll.clientHeight;
    if (!containerWidth || !containerHeight) return;

    const naturalWidth = els.eegImage.naturalWidth;
    const naturalHeight = els.eegImage.naturalHeight;
    const scale = Math.min(
      (containerWidth * 0.98) / naturalWidth,
      (containerHeight * 0.98) / naturalHeight
    );
    const width = Math.max(1, Math.floor(naturalWidth * scale));
    const height = Math.max(1, Math.floor(naturalHeight * scale));

    els.viewer.style.width = `${width}px`;
    els.viewer.style.height = `${height}px`;
  }

  function renderChannelConfig() {
    const image = getCurrentImage();
    const layout = image ? image.layout : state.layoutPreset;

    els.plotLeftInput.value = round(layout.plotLeftPct, 2);
    els.plotRightInput.value = round(layout.plotRightPct, 2);
    els.channelConfig.innerHTML = "";

    layout.channels.forEach((channel, index) => {
      const row = document.createElement("div");
      row.className = "channel-row";

      const name = document.createElement("div");
      name.className = "channel-name";
      name.textContent = channel.name.replace("EEG ", "");

      const top = makeNumberField("上边界 %", channel.topPct, (value) => {
        updateChannelLayout(index, "topPct", value);
      });
      const bottom = makeNumberField("下边界 %", channel.bottomPct, (value) => {
        updateChannelLayout(index, "bottomPct", value);
      });
      const actions = document.createElement("div");
      actions.className = "calibration-mini-actions";
      const topButton = makeCalibrationButton("点上", `channel:${index}:topPct`);
      const bottomButton = makeCalibrationButton("点下", `channel:${index}:bottomPct`);
      actions.append(topButton, bottomButton);

      row.append(name, top, bottom, actions);
      els.channelConfig.appendChild(row);
    });
    updateCalibrationUi();
  }

  function makeNumberField(labelText, value, onInput) {
    const label = document.createElement("label");
    label.className = "field";
    const span = document.createElement("span");
    span.textContent = labelText;
    const input = document.createElement("input");
    input.type = "number";
    input.min = "0";
    input.max = "100";
    input.step = "0.1";
    input.value = round(value, 2);
    input.addEventListener("input", () => onInput(input.value));
    label.append(span, input);
    return label;
  }

  function makeCalibrationButton(labelText, target) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "button secondary mini";
    button.textContent = labelText;
    button.dataset.calibrationTarget = target;
    button.addEventListener("click", () => setCalibrationTarget(target));
    return button;
  }

  function renderAnnotationsOnly() {
    const image = getCurrentImage();
    els.overlay.innerHTML = "";
    updateAnnotationToolStates();
    if (!image || !els.eegImage.naturalWidth) {
      renderSelectionDetails();
      renderAnnotationTables();
      return;
    }

    const regions = getChannelRegions(image);
    const plot = getPlotBounds(image);

    for (const region of regions) {
      const rect = svgEl("rect", {
        x: plot.left,
        y: region.top,
        width: plot.right - plot.left,
        height: region.bottom - region.top,
        class: "channel-band"
      });
      const label = svgEl("text", {
        x: plot.left + 12,
        y: region.top + 34,
        class: "channel-label"
      });
      label.textContent = region.name.replace("EEG ", "");
      els.overlay.append(rect, label);
    }

    for (const annotation of getAnnotationsForActiveEvent(image)) {
      const normalized = annotationBox(image, annotation);
      if (!normalized) continue;
      const rect = svgEl("rect", {
        x: normalized.x1,
        y: normalized.y1,
        width: normalized.x2 - normalized.x1,
        height: normalized.y2 - normalized.y1,
        class: `annotation-rect${annotation.source === "reference" ? " reference" : ""}${annotation.id === state.selectedAnnotationId ? " selected" : ""}`,
        "data-id": annotation.id
      });
      rect.addEventListener("pointerdown", (event) => {
        event.stopPropagation();
        beginAnnotationEdit(event, annotation, "move");
      });
      els.overlay.appendChild(rect);

      if (annotation.id === state.selectedAnnotationId) {
        for (const handle of getResizeHandles(normalized)) {
          const handleRect = svgEl("rect", {
            x: handle.x - 7,
            y: handle.y - 7,
            width: 14,
            height: 14,
            class: `resize-handle ${handle.name}`,
            "data-handle": handle.name
          });
          handleRect.addEventListener("pointerdown", (event) => {
            event.stopPropagation();
            beginAnnotationEdit(event, annotation, "resize", handle.name);
          });
          els.overlay.appendChild(handleRect);
        }
      }
    }

    if (state.drag && state.drag.mode === "create") {
      const box = normalizeBox(state.drag);
      els.overlay.appendChild(svgEl("rect", {
        x: box.x1,
        y: box.y1,
        width: box.x2 - box.x1,
        height: box.y2 - box.y1,
        class: "draft-rect"
      }));
    }

    if (state.calibrationTarget) {
      const hitLayer = svgEl("rect", {
        x: 0,
        y: 0,
        width: getImageWidth(image),
        height: getImageHeight(image),
        class: "calibration-hit-layer"
      });
      hitLayer.addEventListener("pointerdown", (event) => {
        event.stopPropagation();
        applyCalibrationPoint(getSvgPoint(event));
      });
      els.overlay.appendChild(hitLayer);
    }

    renderSelectionDetails();
    renderAnnotationTables();
  }

  function renderSelectionDetails() {
    const image = getCurrentImage();
    const annotation = getSelectedAnnotation();
    if (!image || !annotation) {
      els.selectionDetails.className = "selection-strip muted";
      els.selectionDetails.textContent = "尚未选择标注框。";
      return;
    }

    const rows = computeRowsForAnnotation(image, annotation);
    const timeRange = getTimeRange(image, annotation);
    els.selectionDetails.className = "selection-strip";
    els.selectionDetails.innerHTML = "";
    addDetail("起点", `${formatSecond(timeRange.start)} s`);
    addDetail("终点", `${formatSecond(timeRange.end)} s`);
    addDetail("通道", rows.length ? rows.map((row) => row.channel.replace("EEG ", "")).join("、") : "无：未超过 50% 阈值");
    addDetail("持续时间", `${formatSecond(timeRange.end - timeRange.start)} s`);
    addDetail("事件类型", EVENT_LABELS[annotation.eventType] || annotation.eventType);

    function addDetail(label, value) {
      const row = document.createElement("div");
      row.className = "detail-row";
      const span = document.createElement("span");
      span.textContent = label;
      const strong = document.createElement("strong");
      strong.textContent = value;
      row.append(span, strong);
      els.selectionDetails.appendChild(row);
    }
  }

  function renderAnnotationTables() {
    const image = getCurrentImage();
    const currentItems = image
      ? getAnnotationsForActiveEvent(image).map((annotation, index) => ({ image, annotation, index }))
      : [];
    const allItems = state.images.flatMap((item) =>
      getAnnotationsForActiveEvent(item).map((annotation, index) => ({ image: item, annotation, index }))
    );
    const eventLabel = EVENT_LABELS[state.activeEventType] || state.activeEventType;

    renderAnnotationList({
      table: els.currentAnnotationTable,
      count: els.currentAnnotationCount,
      items: currentItems,
      emptyText: image ? `当前图片还没有${eventLabel}标注。` : "未加载图片。",
      includeImageName: false
    });

    renderAnnotationList({
      table: els.annotationTable,
      count: els.annotationCount,
      items: allItems,
      emptyText: `本轮还没有${eventLabel}标注。`,
      includeImageName: true
    });
  }

  function renderAnnotationList({ table, count, items, emptyText, includeImageName }) {
    table.innerHTML = "";
    count.textContent = String(items.length);

    if (!items.length) {
      const empty = document.createElement("div");
      empty.className = "status-line";
      empty.textContent = emptyText;
      table.appendChild(empty);
      return;
    }

    items.forEach(({ image, annotation, index }, listIndex) => {
      const rows = computeRowsForAnnotation(image, annotation);
      const timeRange = getTimeRange(image, annotation);
      const card = document.createElement("button");
      card.type = "button";
      card.className = `annotation-card${image.id === state.currentImageId && annotation.id === state.selectedAnnotationId ? " selected" : ""}`;
      card.addEventListener("click", () => {
        state.currentImageId = image.id;
        state.selectedAnnotationId = annotation.id;
        render();
      });

      const channelsText = rows.length
        ? rows.map((row) => row.channel.replace("EEG ", "")).join(", ")
        : "未超过通道 50% 阈值";
      const eventLabel = EVENT_LABELS[annotation.eventType] || annotation.eventType;
      if (!includeImageName) {
        card.classList.add("compact");
        const title = document.createElement("span");
        title.className = "annotation-card-title";
        title.textContent = `${eventLabel}  ${formatSecond(timeRange.start)}–${formatSecond(timeRange.end)} s`;
        const channels = document.createElement("span");
        channels.className = `annotation-card-meta${rows.length ? "" : " warning"}`;
        channels.textContent = channelsText;
        card.append(title, channels);
        table.appendChild(card);
        return;
      }

      const epochLine = document.createElement("div");
      epochLine.className = "annotation-card-title annotation-card-line";
      epochLine.textContent = `Epoch ${getEpochIndex(image)} · ${eventLabel}`;

      const timeLine = document.createElement("div");
      timeLine.className = "annotation-card-meta annotation-card-line";
      timeLine.textContent = `${formatSecond(timeRange.start)}-${formatSecond(timeRange.end)} s`;

      const channelLine = document.createElement("div");
      channelLine.className = `annotation-card-meta annotation-card-line${rows.length ? "" : " warning"}`;
      channelLine.textContent = channelsText;

      card.append(epochLine, timeLine, channelLine);
      table.appendChild(card);
    });
  }

  function startDrag(event) {
    const image = getCurrentImage();
    if (!image || !els.eegImage.naturalWidth) return;
    if (state.calibrationTarget) {
      applyCalibrationPoint(getSvgPoint(event));
      return;
    }
    const point = getSvgPoint(event);
    state.drag = { mode: "create", x1: point.x, y1: point.y, x2: point.x, y2: point.y };
    state.selectedAnnotationId = null;
    els.overlay.setPointerCapture(event.pointerId);
    renderAnnotationsOnly();
  }

  function moveDrag(event) {
    if (!state.drag) return;
    const point = getSvgPoint(event);
    if (state.drag.mode === "move") {
      moveAnnotationBox(point);
    } else if (state.drag.mode === "resize") {
      resizeAnnotationBox(point);
    } else {
      state.drag.x2 = point.x;
      state.drag.y2 = point.y;
    }
    renderAnnotationsOnly();
  }

  function endDrag(event) {
    const image = getCurrentImage();
    if (!state.drag || !image) return;

    if (state.drag.mode === "move" || state.drag.mode === "resize") {
      const point = getSvgPoint(event);
      if (state.drag.mode === "move") {
        moveAnnotationBox(point);
      } else {
        resizeAnnotationBox(point);
      }
      const annotation = getSelectedAnnotation();
      if (annotation) {
        const bounded = boundBoxToImage(image, annotationBox(image, annotation));
        setAnnotationBox(annotation, bounded);
        annotation.updatedAt = new Date().toISOString();
      }
      state.drag = null;
      persistSoon("标注框已更新。");
      renderAnnotationsOnly();
      return;
    }

    const point = getSvgPoint(event);
    state.drag.x2 = point.x;
    state.drag.y2 = point.y;
    const box = normalizeBox(state.drag);
    state.drag = null;

    if ((box.x2 - box.x1) < 8 || (box.y2 - box.y1) < 8) {
      renderAnnotationsOnly();
      return;
    }

    const plot = getPlotBounds(image);
    const annotation = {
      id: makeId("ann"),
      eventType: state.activeEventType,
      x1: clamp(box.x1, plot.left, plot.right),
      y1: clamp(box.y1, 0, els.eegImage.naturalHeight),
      x2: clamp(box.x2, plot.left, plot.right),
      y2: clamp(box.y2, 0, els.eegImage.naturalHeight),
      createdAt: new Date().toISOString()
    };
    const rows = computeRowsForAnnotation(image, annotation);
    const span = plot.right - plot.left;
    const created = rows.map(row => ({
      id: JSON.stringify([annotation.id, row.channel]), eventId: annotation.id,
      eventType: annotation.eventType, channel: row.channel, source: "manual",
      startFraction: (annotation.x1 - plot.left) / span,
      endFraction: (annotation.x2 - plot.left) / span
    }));
    image.annotations.push(...created);
    state.selectedAnnotationId = created[0]?.id || null;
    persistSoon("标注已保存。");
    renderImageList();
    renderAnnotationsOnly();
  }

  function cancelDrag() {
    state.drag = null;
    renderAnnotationsOnly();
  }

  function beginAnnotationEdit(event, annotation, mode, handle = null) {
    const point = getSvgPoint(event);
    state.selectedAnnotationId = annotation.id;
    state.drag = {
      mode,
      handle,
      annotationId: annotation.id,
      startPoint: point,
      originalBox: annotationBox(getCurrentImage(), annotation)
    };
    els.overlay.setPointerCapture(event.pointerId);
    renderAnnotationsOnly();
  }

  function moveAnnotationBox(point) {
    const image = getCurrentImage();
    const annotation = getSelectedAnnotation();
    if (!image || !annotation || !state.drag) return;

    const original = state.drag.originalBox;
    const width = original.x2 - original.x1;
    const height = original.y2 - original.y1;
    const dx = point.x - state.drag.startPoint.x;
    const dy = point.y - state.drag.startPoint.y;
    const plot = getPlotBounds(image);
    const imageHeight = getImageHeight(image);
    const x1 = clamp(original.x1 + dx, plot.left, plot.right - width);
    const y1 = clamp(original.y1 + dy, 0, imageHeight - height);
    setAnnotationBox(annotation, {
      x1,
      y1,
      x2: x1 + width,
      y2: y1 + height
    });
  }

  function resizeAnnotationBox(point) {
    const image = getCurrentImage();
    const annotation = getSelectedAnnotation();
    if (!image || !annotation || !state.drag) return;

    const minSize = 8;
    const original = state.drag.originalBox;
    const plot = getPlotBounds(image);
    const imageHeight = getImageHeight(image);
    const box = { ...original };

    if (state.drag.handle.includes("w")) {
      box.x1 = clamp(point.x, plot.left, original.x2 - minSize);
    }
    if (state.drag.handle.includes("e")) {
      box.x2 = clamp(point.x, original.x1 + minSize, plot.right);
    }
    if (state.drag.handle.includes("n")) {
      box.y1 = clamp(point.y, 0, original.y2 - minSize);
    }
    if (state.drag.handle.includes("s")) {
      box.y2 = clamp(point.y, original.y1 + minSize, imageHeight);
    }

    setAnnotationBox(annotation, box);
  }

  function setAnnotationBox(annotation, box) {
    if (Number.isFinite(annotation.startFraction)) {
      const image = getCurrentImage();
      const plot = getPlotBounds(image);
      annotation.startFraction = clamp((box.x1 - plot.left) / (plot.right - plot.left), 0, 1);
      annotation.endFraction = clamp((box.x2 - plot.left) / (plot.right - plot.left), 0, 1);
      const best = getChannelRegions(image).map(c => ({
        c, overlap: Math.max(0, Math.min(c.bottom, box.y2) - Math.max(c.top, box.y1))
      })).sort((a, b) => b.overlap - a.overlap)[0];
      if (best?.overlap > 0) annotation.channel = EventGeometry.channel(best.c.name);
      return;
    }
    annotation.x1 = box.x1;
    annotation.y1 = box.y1;
    annotation.x2 = box.x2;
    annotation.y2 = box.y2;
  }

  function boundBoxToImage(image, box) {
    const plot = getPlotBounds(image);
    const imageHeight = getImageHeight(image);
    return {
      x1: clamp(box.x1, plot.left, plot.right),
      y1: clamp(box.y1, 0, imageHeight),
      x2: clamp(box.x2, plot.left, plot.right),
      y2: clamp(box.y2, 0, imageHeight)
    };
  }

  function getResizeHandles(box) {
    return [
      { name: "nw", x: box.x1, y: box.y1 },
      { name: "ne", x: box.x2, y: box.y1 },
      { name: "sw", x: box.x1, y: box.y2 },
      { name: "se", x: box.x2, y: box.y2 }
    ];
  }

  function moveCurrentImage(step) {
    if (!state.images.length) return;
    const currentIndex = Math.max(0, state.images.findIndex((image) => image.id === state.currentImageId));
    const nextIndex = clamp(currentIndex + step, 0, state.images.length - 1);
    if (nextIndex === currentIndex) return;
    state.currentImageId = state.images[nextIndex].id;
    state.selectedAnnotationId = null;
    state.imageSearch = "";
    state.imageFilter = "all";
    els.epochSearchInput.value = "";
    persistSoon(`已切换到第 ${nextIndex + 1} 张。`);
    render();
  }

  function deleteSelectedAnnotation() {
    const image = getCurrentImage();
    if (!image || !state.selectedAnnotationId) return;
    image.annotations = image.annotations.filter((annotation) => annotation.id !== state.selectedAnnotationId);
    state.selectedAnnotationId = null;
    persistSoon("已删除标注。");
    renderImageList();
    renderAnnotationsOnly();
  }

  function updateLayoutValue(key, value) {
    const image = getCurrentImage();
    if (!image) return;
    image.layout[key] = clamp(parseFloatOrZero(value), 0, 100);
    rememberLayoutPreset(image);
    persistSoon("布局校准已更新。");
    updateCalibrationUi();
    renderAnnotationsOnly();
  }

  function updateChannelLayout(index, key, value) {
    const image = getCurrentImage();
    if (!image) return;
    image.layout.channels[index][key] = clamp(parseFloatOrZero(value), 0, 100);
    rememberLayoutPreset(image);
    persistSoon("通道区域已更新。");
    updateCalibrationUi();
    renderAnnotationsOnly();
  }

  function resetCalibration() {
    state.layoutPreset = cloneLayout(DEFAULT_LAYOUT);
    state.images.forEach((image) => {
      image.layout = cloneLayout(state.layoutPreset);
    });
    state.calibrationTarget = null;
    persistSoon("已恢复示例布局。");
    render();
  }

  function setCalibrationTarget(target) {
    if (!getCurrentImage()) {
      els.calibrationStatus.textContent = "请先载入并选择一张图片。";
      return;
    }
    state.calibrationTarget = state.calibrationTarget === target ? null : target;
    updateCalibrationUi();
    renderAnnotationsOnly();
  }

  function applyCalibrationPoint(point) {
    const image = getCurrentImage();
    if (!image || !state.calibrationTarget) return;

    const target = state.calibrationTarget;
    if (target === "plotLeftPct" || target === "plotRightPct") {
      image.layout[target] = round((point.x / getImageWidth(image)) * 100, 3);
    } else if (target.startsWith("channel:")) {
      const [, indexText, key] = target.split(":");
      const index = Number(indexText);
      if (image.layout.channels[index] && (key === "topPct" || key === "bottomPct")) {
        image.layout.channels[index][key] = round((point.y / getImageHeight(image)) * 100, 3);
      }
    }

    rememberLayoutPreset(image);
    state.calibrationTarget = null;
    persistSoon("点选校准已更新。");
    renderChannelConfig();
    renderAnnotationsOnly();
  }

  function updateCalibrationUi() {
    document.querySelectorAll("[data-calibration-target]").forEach((button) => {
      button.classList.toggle("is-active", button.dataset.calibrationTarget === state.calibrationTarget);
    });

    if (!els.calibrationStatus) return;
    if (!state.calibrationTarget) {
      els.calibrationStatus.textContent = "可手动输入百分比，也可点击对应按钮后在图上点选。";
      els.overlay.classList.remove("is-calibrating");
      return;
    }

    els.overlay.classList.add("is-calibrating");
    els.calibrationStatus.textContent = `正在校准：${describeCalibrationTarget(state.calibrationTarget)}。请在 EEG 图片上点一下对应位置。`;
  }

  function describeCalibrationTarget(target) {
    const image = getCurrentImage();
    if (target === "plotLeftPct") return "时间轴左端";
    if (target === "plotRightPct") return "时间轴右端";
    if (target.startsWith("channel:") && image) {
      const [, indexText, key] = target.split(":");
      const channel = image.layout.channels[Number(indexText)];
      const edge = key === "topPct" ? "上边界" : "下边界";
      return `${channel ? channel.name.replace("EEG ", "") : "通道"} ${edge}`;
    }
    return "布局边界";
  }

  function getSvgPoint(event) {
    const rect = els.overlay.getBoundingClientRect();
    const width = els.eegImage.naturalWidth || rect.width;
    const height = els.eegImage.naturalHeight || rect.height;
    return {
      x: clamp(((event.clientX - rect.left) / rect.width) * width, 0, width),
      y: clamp(((event.clientY - rect.top) / rect.height) * height, 0, height)
    };
  }

  function getPlotBounds(image) {
    const width = getImageWidth(image);
    return {
      left: (image.layout.plotLeftPct / 100) * width,
      right: (image.layout.plotRightPct / 100) * width
    };
  }

  function getChannelRegions(image) {
    const height = getImageHeight(image);
    return image.layout.channels.map((channel) => ({
      name: channel.name,
      top: (channel.topPct / 100) * height,
      bottom: (channel.bottomPct / 100) * height
    }));
  }

  function annotationBox(image, annotation) {
    if (Number.isFinite(annotation.startFraction)) {
      if (!image.layout.calibrated) return null;
      return EventGeometry.project(annotation, image, getImageWidth(image), getImageHeight(image));
    }
    return normalizeBox(annotation);
  }

  function getTimeRange(image, annotation) {
    if (Number.isFinite(annotation.startFraction)) return {
      start: image.windowStart + annotation.startFraction * image.windowDuration,
      end: image.windowStart + annotation.endFraction * image.windowDuration
    };
    const plot = getPlotBounds(image);
    const box = normalizeBox(annotation);
    const duration = Number(image.windowDuration || 20);
    const width = Math.max(plot.right - plot.left, 1);
    const start = Number(image.windowStart || 0) + ((box.x1 - plot.left) / width) * duration;
    const end = Number(image.windowStart || 0) + ((box.x2 - plot.left) / width) * duration;
    return {
      start: Math.min(start, end),
      end: Math.max(start, end)
    };
  }

  function computeRowsForAnnotation(image, annotation) {
    if (Number.isFinite(annotation.startFraction)) {
      const time = getTimeRange(image, annotation);
      const start = getEpochPositionForTime(image, time.start);
      const end = getEpochPositionForTime(image, time.end);
      return [{
        type: CSV_EVENT_TYPES[annotation.eventType] || annotation.eventType,
        start_epoch: start.epoch, start_offset: start.offset,
        end_epoch: end.epoch, end_offset: end.offset, channel: annotation.channel,
        dataset_name: image.datasetName || annotation.datasetName || state.datasetName,
        image_name: image.name, duration_s: time.end - time.start,
        annotation_id: annotation.eventId || annotation.id
      }];
    }
    const box = normalizeBox(annotation);
    const timeRange = getTimeRange(image, box);
    const channels = getChannelRegions(image);
    const startPosition = getEpochPositionForTime(image, timeRange.start);
    const endPosition = getEpochPositionForTime(image, timeRange.end);
    const rows = [];

    channels.forEach((channel) => {
      const channelHeight = Math.max(channel.bottom - channel.top, 1);
      const overlap = Math.max(0, Math.min(box.y2, channel.bottom) - Math.max(box.y1, channel.top));
      const overlapRatio = overlap / channelHeight;
      if (overlapRatio > OVERLAP_THRESHOLD) {
        rows.push({
          type: CSV_EVENT_TYPES[annotation.eventType] || annotation.eventType,
          start_epoch: startPosition.epoch,
          start_offset: startPosition.offset,
          end_epoch: endPosition.epoch,
          end_offset: endPosition.offset,
          channel: toCsvChannelName(channel.name),
          image_name: image.name,
          event_type: annotation.eventType,
          event_label: EVENT_LABELS[annotation.eventType] || annotation.eventType,
          start_time: timeRange.start,
          end_time: timeRange.end,
          duration_s: timeRange.end - timeRange.start,
          window_start: Number(image.windowStart || 0),
          window_duration: Number(image.windowDuration || 20),
          x1: box.x1,
          y1: box.y1,
          x2: box.x2,
          y2: box.y2,
          overlap_ratio: overlapRatio,
          annotation_id: annotation.id
        });
      }
    });

    return rows;
  }

  async function exportCsv() {
    updateTaskProgress(20, "正在生成 CSV 行...");
    await waitForNextPaint();
    const { csv, rowCount } = buildCsv();
    if (state.api.available) {
      try {
        updateTaskProgress(65, "正在写入默认 CSV 文件...", `${rowCount} 行标注`);
        const result = await postJson("api/save-csv", { csv, context: PROJECT_CONTEXT });
        persistNow(`已写入 ${rowCount} 行到 ${result.csvPath || "CSV 文件"}。`);
        return {
          message: `已导出 ${rowCount} 行 CSV。`,
          detail: result.csvPath || "CSV 文件"
        };
      } catch (error) {
        console.warn("Default CSV write failed; falling back to a local export.", error);
      }
    }
    updateTaskProgress(70, "请选择 CSV 保存位置...", `${rowCount} 行标注`);
    const pickerResult = await saveCsvWithPicker(csv, rowCount);
    if (pickerResult === "saved") {
      return { message: `已导出 ${rowCount} 行 CSV。` };
    }
    if (pickerResult === "cancelled") {
      return { message: "已取消导出 CSV。" };
    }
    downloadText(`${safeFileName(state.datasetName)}.csv`, csv, "text/csv;charset=utf-8");
    els.saveStatus.textContent = `已导出 ${rowCount} 行 CSV。`;
    return { message: `已下载 ${rowCount} 行 CSV。` };
  }

  async function saveCsvWithPicker(csv, rowCount) {
    if (!window.showSaveFilePicker) return "unsupported";
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: `${safeFileName(state.datasetName)}.csv`,
        types: [
          {
            description: "CSV 文件",
            accept: { "text/csv": [".csv"] }
          }
        ]
      });
      const writable = await handle.createWritable();
      await writable.write(new Blob([csv], { type: "text/csv;charset=utf-8" }));
      await writable.close();
      els.saveStatus.textContent = `已重写 CSV，共 ${rowCount} 行。`;
      return "saved";
    } catch (error) {
      if (error && error.name === "AbortError") {
        els.saveStatus.textContent = "已取消导出 CSV。";
        return "cancelled";
      }
      console.warn("Save picker failed; falling back.", error);
      return "unsupported";
    }
  }

  function buildCsv() {
    const rows = state.images.flatMap((image) =>
      image.annotations.flatMap((annotation) => computeRowsForAnnotation(image, annotation))
    );
    const columns = [
      "type",
      "start_epoch",
      "start_offset",
      "end_epoch",
      "end_offset",
      "channel",
      "dataset_name",
      "image_name",
      "duration_s",
      "annotation_id"
    ];
    const csv = [
      columns.join(","),
      ...rows.map((row) => columns.map((column) => csvCell(formatCsvValue(column, row[column]))).join(","))
    ].join("\r\n");
    return { csv, rowCount: rows.length };
  }

  function formatCsvValue(column, value) {
    if (typeof value === "number") {
      if (["start_offset", "end_offset", "duration_s"].includes(column)) {
        return value.toFixed(3);
      }
      return Math.round(value).toString();
    }
    if (column === "dataset_name") return value || state.datasetName;
    return value == null ? "" : String(value);
  }

  function applyWaveManifest(payload) {
    if (!payload || !Array.isArray(payload.images)) {
      throw new Error("manifest 中没有 images 数组。");
    }
    if (!(Number.isFinite(payload.epochLengthSec) && payload.epochLengthSec > 0) ||
        !Number.isInteger(payload.epochBase)) throw new Error("manifest 的 epoch 配置无效。");
    const bindings = payload.images.map(meta => ({ meta, image: findImageByCsvName(meta.name) }));
    if (bindings.some(b => !b.image)) throw new Error("请先加载 manifest 中的全部波形图片。");
    for (const { meta } of bindings) {
      if (!meta.recordingName || !meta.datasetName || !Number.isInteger(meta.epoch) ||
          !Number.isFinite(meta.windowStart) || !(meta.windowDuration > 0) ||
          !Number.isFinite(meta.windowDuration)) throw new Error("manifest 图片时间信息无效。");
    }
    for (const { meta, image } of bindings) {
      Object.assign(image, { recordingName: meta.recordingName, datasetName: meta.datasetName,
        epoch: meta.epoch, epochBase: payload.epochBase, epochLengthSec: payload.epochLengthSec,
        windowStart: meta.windowStart, windowDuration: meta.windowDuration });
    }
    persistNow("图片窗口信息已加载；请设置通道并校准。");
    render();
    return {
      message: `已关联 ${bindings.length} 张底图。`,
      detail: "可以继续导入 detection CSV。"
    };
  }

  async function importCsv(file) {
    const rows = parseCsv(await file.text());
    if (rows.length < 2) throw new Error("CSV 中没有可导入的数据行。");
    const events = EventGeometry.readRows(rows);
    const pending = [];
    let unmatched = 0;
    let outside = 0;
    const unmatchedExamples = [];
    for (const event of events) {
      const exact = findImageByCsvName(event.recordingName);
      let images = exact ? [exact] : state.images.filter(image =>
        image.recordingName === event.recordingName &&
        (!event.datasetName || image.datasetName === event.datasetName));
      if (exact?.recordingName) images = state.images.filter(image =>
        image.recordingName === exact.recordingName && image.datasetName === exact.datasetName);
      if (!images.length) {
        unmatched++;
        if (unmatchedExamples.length < 3) unmatchedExamples.push(event.recordingName || "(空 image_name)");
        continue;
      }
      let visible = 0;
      for (const image of images) {
        const length = image.epochLengthSec || image.windowDuration;
        const base = image.epochBase ?? (getEpochIndexNumber(image) - image.windowStart / length);
        const parts = EventGeometry.fragments(event, image, length, base);
        visible += parts.length;
        for (const part of parts) pending.push({ image, part });
      }
      if (!visible) outside++;
    }
    if (unmatched) {
      const loadedExamples = state.images.slice(0, 3).map(image => image.name).join(", ") || "当前没有已加载图片";
      throw new Error(`${unmatched} 个事件没有匹配的图片窗口。CSV image_name 示例：${unmatchedExamples.join(", ")}。当前底图示例：${loadedExamples}。请先在“文件 -> 生成无标注底图”生成并加载对应版本，或在“项目”里加载已有图片版本；同时确认 CSV 的 image_name 与底图 manifest 中的图片名一致。`);
    }
    let added = 0;
    const missing = new Set();
    for (const { image, part } of pending) {
      if (!image.annotations.some(a => a.id === part.id)) { image.annotations.push(part); added++; }
      if (!image.layout.channels.some(c => EventGeometry.channel(c.name) === part.channel)) missing.add(part.channel);
    }
    persistNow(`已导入 ${added} 个通道片段。`);
    render();
    return { message: `已导入 ${added} 个通道片段。${outside ? `另有 ${outside} 个事件位于已加载窗口之外。` : ""}`,
      detail: missing.size ? `待配置通道：${[...missing].join(", ")}；设置并校准后自动显示。`
        : "参考框使用相对时间；请在布局校准中确认校准并显示标注框。每个通道、窗口片段可独立编辑。" };
  }

  function getEpochCsvGeometry(row, headerIndex, imageName) {
    const image = findImageByCsvName(imageName);
    if (!image) {
      throw new Error(`找不到 CSV 中对应的图片：${imageName}。请先载入图片，再导入该 CSV。`);
    }
    const startTime = getAbsoluteTimeFromEpochPosition(
      image,
      csvValue(row, headerIndex, "start_epoch"),
      csvValue(row, headerIndex, "start_offset")
    );
    const endTime = getAbsoluteTimeFromEpochPosition(
      image,
      csvValue(row, headerIndex, "end_epoch"),
      csvValue(row, headerIndex, "end_offset")
    );
    if (startTime == null || endTime == null) return null;

    const plot = getPlotBounds(image);
    const duration = Math.max(Number(image.epochLengthSec || image.windowDuration || state.defaultWindowDuration || 30), 1);
    const plotWidth = Math.max(plot.right - plot.left, 1);
    const x1 = plot.left + ((startTime - Number(image.windowStart || 0)) / duration) * plotWidth;
    const x2 = plot.left + ((endTime - Number(image.windowStart || 0)) / duration) * plotWidth;
    const channelName = csvValue(row, headerIndex, "channel");
    const channel = findChannelRegionForCsvChannel(image, channelName);
    if (!channel) {
      throw new Error(`当前图片布局中找不到通道：${channelName}。请先校准或添加对应通道。`);
    }
    return {
      x1: clamp(x1, 0, getImageWidth(image)),
      y1: channel.top,
      x2: clamp(x2, 0, getImageWidth(image)),
      y2: channel.bottom
    };
  }

  function findImageByCsvName(imageName) {
    const key = normalizeImageLookupName(imageName);
    return state.images.find((image) =>
      [image.name, image.relativePath, image.serverId].some((value) => normalizeImageLookupName(value) === key)
    );
  }

  function findChannelRegionForCsvChannel(image, channelName) {
    const key = normalizeChannelKey(toCsvChannelName(channelName));
    return getChannelRegions(image).find((channel) => normalizeChannelKey(toCsvChannelName(channel.name)) === key);
  }

  function getPersistableState() {
    return {
      version: 1,
      datasetName: state.datasetName,
      currentImageId: state.currentImageId,
      activeEventType: state.activeEventType,
      layoutPreset: cloneLayout(state.layoutPreset),
      defaultWindowDuration: state.defaultWindowDuration,
      ...(state.unmatchedReferences.length ? { referenceAnnotations: state.unmatchedReferences } : {}),
      images: state.images.map((image) => ({
          ...image,
          naturalWidth: image.naturalWidth || null,
          naturalHeight: image.naturalHeight || null,
          layout: cloneLayout(image.layout),
          annotations: image.annotations.map((annotation) => ({ ...annotation }))
      }))
    };
  }

  let saveTimer = null;
  function persistSoon(message) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => persistNow(message), 250);
  }

  function persistNow(message) {
    const snapshot = getPersistableState();
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot)); }
    catch (error) { console.warn("Browser backup unavailable", error); }
    if (PROJECT_CONTEXT && state.api.config?.generation) {
      els.saveStatus.textContent = "正在保存项目标注…";
      projectSaveQueue = projectSaveQueue.then(async () => {
        try {
          await postJson("api/project/save", { context: PROJECT_CONTEXT, state: snapshot });
          projectSaveError = null;
          els.saveStatus.textContent = "已保存到项目目录。";
        } catch (error) {
          projectSaveError = error;
          els.saveStatus.textContent = "项目保存失败，请勿关闭页面：" + error.message;
        }
      });
      return;
    }
    if (message) els.saveStatus.textContent = message;
  }

  function loadState() {
    const saved = window.__EEG_SERVER_BOOTSTRAP__?.savedState;
    const raw = saved ? JSON.stringify(saved) : localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    try {
      const payload = JSON.parse(raw);
      state.datasetName = payload.datasetName || state.datasetName;
      state.currentImageId = payload.currentImageId || null;
      state.activeEventType = normalizeEventType(payload.activeEventType || state.activeEventType);
      state.layoutPreset = payload.layoutPreset
        ? cloneLayout(payload.layoutPreset)
        : cloneLayout((Array.isArray(payload.images) && payload.images.find((image) => image && image.layout) || {}).layout || DEFAULT_LAYOUT);
      state.defaultWindowDuration = Number(
        payload.defaultWindowDuration ||
        (Array.isArray(payload.images) && payload.images.find((image) => image && image.windowDuration) || {}).windowDuration ||
        state.defaultWindowDuration
      );
      state.images = Array.isArray(payload.images)
        ? payload.images.map((image) => ({
            ...image,
            source: image.source || "local",
            serverId: image.serverId || null,
            relativePath: image.relativePath || image.name,
            naturalWidth: image.naturalWidth || null,
            naturalHeight: image.naturalHeight || null,
            recordingName: image.recordingName, datasetName: image.datasetName,
        epoch: image.epoch, epochBase: image.epochBase, epochLengthSec: image.epochLengthSec,
        windowStart: Number(image.windowStart || 0),
            windowDuration: Number(image.windowDuration || state.defaultWindowDuration),
            layout: cloneLayout(state.layoutPreset),
            annotations: Array.isArray(image.annotations) ? image.annotations : []
          }))
        : [];
      importLegacyReferences(payload.referenceAnnotations);
      els.saveStatus.textContent = "已载入浏览器中的本地数据集。";
    } catch (error) {
      console.warn("Cannot parse saved state", error);
    }
  }

  async function hydrateImageUrls(onProgress) {
    for (const [id, url] of state.imageUrls.entries()) {
      if (String(url).startsWith("blob:")) URL.revokeObjectURL(url);
      state.imageUrls.delete(id);
    }
    for (let index = 0; index < state.images.length; index += 1) {
      const image = state.images[index];
      if (image.source === "server" && image.serverId) {
        state.imageUrls.set(image.id, `api/image/${encodeURIComponent(image.serverId)}`);
      } else {
        const blob = await getImageBlob(image.id);
        if (blob) {
          state.imageUrls.set(image.id, URL.createObjectURL(blob));
        }
      }
      if (onProgress) onProgress(index + 1, state.images.length, image.relativePath || image.name);
    }
  }

  function openDatabase() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(IMAGE_STORE)) {
          db.createObjectStore(IMAGE_STORE);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  function getImageBlob(id) {
    if (!state.db) return Promise.resolve(null);
    return new Promise((resolve, reject) => {
      const tx = state.db.transaction(IMAGE_STORE, "readonly");
      const request = tx.objectStore(IMAGE_STORE).get(id);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  }

  function svgEl(name, attributes) {
    const element = document.createElementNS("http://www.w3.org/2000/svg", name);
    Object.entries(attributes).forEach(([key, value]) => element.setAttribute(key, String(value)));
    return element;
  }

  function normalizeBox(box) {
    return {
      x1: Math.min(box.x1, box.x2),
      y1: Math.min(box.y1, box.y2),
      x2: Math.max(box.x1, box.x2),
      y2: Math.max(box.y1, box.y2)
    };
  }

  function cloneLayout(layout) {
    const source = layout || DEFAULT_LAYOUT;
    return {
      calibrated: Boolean(source.calibrated),
      plotLeftPct: Number(source.plotLeftPct),
      plotRightPct: Number(source.plotRightPct),
      channels: source.channels.map((channel) => ({
        name: channel.name,
        topPct: Number(channel.topPct),
        bottomPct: Number(channel.bottomPct)
      }))
    };
  }

  function rememberLayoutPreset(image) {
    if (!image || !image.layout) return;
    state.layoutPreset = cloneLayout(image.layout);
    state.images.forEach((item) => {
      item.layout = cloneLayout(state.layoutPreset);
    });
  }

  function importLegacyReferences(references) {
    let added = 0;
    const unmatched = [];
    for (const reference of Array.isArray(references) ? references : []) {
      const image = findImageByCsvName(reference && reference.imageName);
      if (!image) {
        unmatched.push(reference);
        continue;
      }
      if (addReferenceAsAnnotation(image, reference)) added += 1;
    }
    state.unmatchedReferences = unmatched;
    return added;
  }

  function addReferenceAsAnnotation(image, reference) {
    if (!image || !reference) return false;
    const coordinates = [reference.x1, reference.y1, reference.x2, reference.y2].map(parseOptionalNumber);
    if (coordinates.some((value) => value == null)) return false;
    const id = reference.annotationId || reference.id || makeId("ann");
    if (image.annotations.some((annotation) => annotation.id === id)) return false;
    const box = normalizeBox({
      x1: coordinates[0],
      y1: coordinates[1],
      x2: coordinates[2],
      y2: coordinates[3]
    });
    image.annotations.push({
      id,
      eventType: normalizeEventType(reference.eventType),
      ...box,
      source: "reference",
      createdAt: new Date().toISOString()
    });
    return true;
  }

  function normalizeRelativePath(path) {
    return String(path || "").replace(/\\/g, "/").replace(/^\/+/, "");
  }

  function normalizeImageLookupName(name) {
    return normalizeRelativePath(name).split("/").pop().toLowerCase();
  }

  function getImageWidth(image) {
    return image.naturalWidth || (image.id === state.currentImageId ? els.eegImage.naturalWidth : 0) || 1;
  }

  function getImageHeight(image) {
    return image.naturalHeight || (image.id === state.currentImageId ? els.eegImage.naturalHeight : 0) || 1;
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function parseFloatOrZero(value) {
    const parsed = parseFloat(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function parseOptionalNumber(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  async function requestJson(url) {
    const bootstrapped = getBootstrappedJson(url);
    if (bootstrapped) return bootstrapped;
    if (typeof window.fetch === "function") {
      const response = await window.fetch(url, { cache: "no-store" });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(text || `请求失败：${response.status}`);
      }
      return response.json();
    }
    return requestJsonWithXhr(url);
  }

  async function postJson(url, payload) {
    if (typeof window.fetch === "function") {
      const response = await window.fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-EEG-Token": window.__EEG_SERVER_BOOTSTRAP__?.token || "" },
        body: JSON.stringify(payload)
      });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(text || `请求失败：${response.status}`);
      }
      return response.json();
    }
    if (typeof window.XMLHttpRequest !== "function") {
      throw new Error("当前浏览器环境不支持直接写入本地服务，将改为下载 CSV。");
    }
    return requestJsonWithXhr(url, {
      method: "POST",
      body: JSON.stringify(payload),
      headers: { "Content-Type": "application/json", "X-EEG-Token": window.__EEG_SERVER_BOOTSTRAP__?.token || "" }
    });
  }

  function requestJsonWithXhr(url, options = {}) {
    return new Promise((resolve, reject) => {
      const request = new XMLHttpRequest();
      request.open(options.method || "GET", url, true);
      Object.entries(options.headers || {}).forEach(([key, value]) => {
        request.setRequestHeader(key, value);
      });
      request.onload = () => {
        if (request.status < 200 || request.status >= 300) {
          reject(new Error(request.responseText || `请求失败：${request.status}`));
          return;
        }
        try {
          resolve(JSON.parse(request.responseText));
        } catch (error) {
          reject(error);
        }
      };
      request.onerror = () => reject(new Error("网络请求失败。"));
      request.send(options.body || null);
    });
  }

  function getBootstrappedJson(url) {
    const bootstrap = window.__EEG_SERVER_BOOTSTRAP__;
    if (!bootstrap) return null;
    if (url === "api/config" || url === "/api/config") {
      return clonePlainObject(bootstrap.config || {});
    }
    if (url === "api/images" || url === "/api/images") {
      return { images: clonePlainObject(bootstrap.images || []) };
    }
    return null;
  }

  function clonePlainObject(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function round(value, digits) {
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
  }

  function formatSecond(value) {
    return Number(value || 0).toFixed(3).replace(/\.?0+$/, "");
  }

  function makeId(prefix) {
    const random = Math.random().toString(36).slice(2, 9);
    return `${prefix}_${Date.now().toString(36)}_${random}`;
  }

  function safeFileName(name) {
    return (name || "eeg-image-annotations").replace(/[\\/:*?"<>|]+/g, "_");
  }

  function csvCell(value) {
    const text = String(value);
    if (/[",\r\n]/.test(text)) {
      return `"${text.replace(/"/g, '""')}"`;
    }
    return text;
  }

  function parseCsv(text) {
    const rows = [];
    let row = [];
    let cell = "";
    let inQuotes = false;

    for (let index = 0; index < text.length; index += 1) {
      const char = text[index];
      const next = text[index + 1];
      if (inQuotes) {
        if (char === '"' && next === '"') {
          cell += '"';
          index += 1;
        } else if (char === '"') {
          inQuotes = false;
        } else {
          cell += char;
        }
      } else if (char === '"') {
        inQuotes = true;
      } else if (char === ",") {
        row.push(cell);
        cell = "";
      } else if (char === "\n") {
        row.push(cell);
        rows.push(row);
        row = [];
        cell = "";
      } else if (char !== "\r") {
        cell += char;
      }
    }

    row.push(cell);
    if (row.length > 1 || row[0] !== "") rows.push(row);
    return rows;
  }

  function csvValue(row, headerIndex, column) {
    const index = headerIndex.get(column);
    return index == null ? "" : String(row[index] || "").trim();
  }

  function downloadText(filename, content, type) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
})();
