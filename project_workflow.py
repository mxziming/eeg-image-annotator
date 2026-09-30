"""Local project persistence and isolated waveform-generation jobs."""
from __future__ import annotations

import json
import math
import os
from pathlib import Path
import subprocess
import sys
import threading
import time
import uuid

from eeg_io import CHANNELS, find_edf_files, normalize_channel

APP_DIR = Path(__file__).resolve().parent


def read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def atomic_json(path, data):
    atomic_text(path, json.dumps(data, ensure_ascii=False, indent=2))


def atomic_text(path, text, backup=False):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    try:
        for attempt in range(25):
            try:
                with temporary.open("w", encoding="utf-8", newline="") as stream:
                    stream.write(text)
                    stream.flush()
                    os.fsync(stream.fileno())
                break
            except PermissionError:
                if attempt == 24:
                    raise
                temporary = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
                time.sleep(0.04 + attempt * 0.01)
        if backup and path.exists():
            # One previous complete save is retained, separate from caches.
            atomic_text(path.with_name(path.stem + ".previous" + path.suffix),
                        path.read_text(encoding="utf-8"))
        for attempt in range(25):
            try:
                os.replace(temporary, path)
                break
            except PermissionError:
                if attempt == 24:
                    raise
                time.sleep(0.04 + attempt * 0.01)
    finally:
        if temporary.exists():
            temporary.unlink()


def overlaps(a, b):
    return a == b or a in b.parents or b in a.parents


def resolve_paths(config_path, config):
    root = config_path.parent.resolve()
    paths = {}
    for name in ("edf_dir", "images_dir", "annotations_dir", "cache_dir", "logs_dir"):
        value = Path(config["paths"][name]).expanduser()
        paths[name] = (root / value).resolve() if not value.is_absolute() else value.resolve()
    if overlaps(root, paths["edf_dir"]):
        raise ValueError("Project and EDF directories must be separate")
    outputs = [paths[k] for k in paths if k != "edf_dir"]
    if any(overlaps(paths["edf_dir"], p) for p in outputs):
        raise ValueError("Output directories must not overlap the EDF input directory")
    if any(p == root or p in root.parents for p in outputs):
        raise ValueError("Use dedicated output subdirectories, not the project root or its ancestors")
    if any(overlaps(a, b) for i, a in enumerate(outputs) for b in outputs[i + 1:]):
        raise ValueError("Images, annotations, cache and logs must use separate directories")
    return paths


def validate_options(values):
    options = dict(dataset_name=str(values.get("dataset_name") or "SouthData"),
                   recording_name=str(values.get("recording_name") or "recording"))
    channels = [normalize_channel(c) for c in values.get("channels", CHANNELS)]
    if not channels or len(channels) != len(set(channels)):
        raise ValueError("Channels must be nonempty and unique")
    for key, default in (("epoch_length_sec", 30), ("amplitude_uv", 100)):
        value = float(values.get(key, default))
        if not math.isfinite(value) or value <= 0:
            raise ValueError(f"{key} must be positive and finite")
        options[key] = value
    for key, default in (("epoch_base", 1), ("dpi", 150), ("start_epoch", None), ("end_epoch", None)):
        value = values.get(key, default)
        if value is not None and (isinstance(value, bool) or int(value) != value):
            raise ValueError(f"{key} must be an integer")
        options[key] = None if value is None else int(value)
    if not 1 <= options["dpi"] <= 600:
        raise ValueError("DPI must be between 1 and 600")
    start = options["epoch_base"] if options["start_epoch"] is None else options["start_epoch"]
    if start < options["epoch_base"] or (options["end_epoch"] is not None and options["end_epoch"] < start):
        raise ValueError("Invalid epoch range")
    band = values.get("display_band")
    if band is not None:
        if len(band) != 2 or not all(math.isfinite(float(v)) for v in band) or not 0 < band[0] < band[1]:
            raise ValueError("Display band needs positive LOW < HIGH")
    options["display_band"] = band
    return channels, options


class ProjectWorkflow:
    def __init__(self):
        self.path = None
        self.config = None
        self.paths = {}
        self.job = None
        self.lock = threading.RLock()

    def busy(self):
        return self.job is not None and self.job["process"].poll() is None

    def open(self, filename):
        with self.lock:
            if self.busy():
                raise ValueError("Wait for or cancel generation before switching projects")
            path = Path(filename).expanduser().resolve()
            if path.is_dir():
                path /= "project.json"
            config = read_json(path)
            if config.get("schema_version") != 1 or not config.get("project_id"):
                raise ValueError("Unsupported project configuration")
            paths = resolve_paths(path, config)
            generation = config.get("active_generation")
            if generation and not re_generation(generation):
                raise ValueError("Invalid generation ID")
            self.path, self.config, self.paths = path, config, paths
            self.job = None
            return self.info()

    def create(self, payload):
        with self.lock:
            if self.busy():
                raise ValueError("Generation is running")
            root = Path(payload["project_dir"]).expanduser().resolve()
            edf = Path(payload["edf_dir"]).expanduser().resolve()
            find_edf_files(edf)
            path = root / "project.json"
            if path.exists():
                raise ValueError("Project already exists; use Open project")
            config = {"schema_version": 1, "project_id": uuid.uuid4().hex,
                      "recording_id": edf.name, "active_generation": None,
                      "paths": {"edf_dir": str(edf), **{
                          k: payload.get(k) or default for k, default in
                          (("images_dir", "images"), ("annotations_dir", "annotations"),
                           ("cache_dir", "cache"), ("logs_dir", "logs"))}}}
            paths = resolve_paths(path, config)
            for key, output in paths.items():
                if key != "edf_dir":
                    output.mkdir(parents=True, exist_ok=True)
            atomic_json(path, config)
            return self.open(path)

    def context(self):
        if not self.config:
            return None
        return self.config["project_id"] + ":" + (self.config.get("active_generation") or "empty")

    def require_context(self, value):
        if not self.config or value != self.context():
            raise ValueError("Project changed in another page; reload before saving or changing it")

    def generation_dir(self):
        generation = self.config.get("active_generation") if self.config else None
        return self.paths["images_dir"] / generation if generation else None

    def annotation_path(self, filename="working.json"):
        generation = self.config.get("active_generation") if self.config else None
        if not generation:
            raise ValueError("Generate or select images first")
        return self.paths["annotations_dir"] / generation / filename

    def info(self):
        if not self.config:
            return {"project": None}
        generations = []
        for manifest in sorted(self.paths["images_dir"].glob("generation_*/images_manifest.json")):
            if re_generation(manifest.parent.name):
                generations.append(manifest.parent.name)
        specification = self.generation_dir() / "generation_config.json" if self.generation_dir() else None
        saved_options = read_json(specification) if specification and specification.is_file() else None
        return {"project": self.config, "configPath": str(self.path), "generationOptions": saved_options,
                "paths": {k: str(v) for k, v in self.paths.items()},
                "context": self.context(), "generations": generations}

    def activate(self, generation, context):
        with self.lock:
            self.require_context(context)
            if self.busy():
                raise ValueError("Generation is still running")
            if not re_generation(generation) or generation not in self.info()["generations"]:
                raise ValueError("Generation is not complete or does not exist")
            self.config["active_generation"] = generation
            atomic_json(self.path, self.config)
            return self.info()

    def save_state(self, payload):
        with self.lock:
            self.require_context(payload.get("context"))
            state = payload["state"]
            if not isinstance(state, dict) or not isinstance(state.get("images"), list):
                raise ValueError("Invalid annotation state")
            atomic_json(self.annotation_path(), state) if not self.annotation_path().exists() else atomic_text(
                self.annotation_path(), json.dumps(state, ensure_ascii=False, indent=2), backup=True)
            return {"ok": True, "path": str(self.annotation_path())}

    def start(self, payload):
        with self.lock:
            self.require_context(payload.get("context"))
            if self.busy():
                raise ValueError("One generation task is already running")
            find_edf_files(self.paths["edf_dir"])
            channels, options = validate_options(payload.get("options", {}))
            generation = "generation_" + uuid.uuid4().hex
            output = self.paths["images_dir"] / generation
            status = self.paths["logs_dir"] / (generation + ".status.json")
            log = self.paths["logs_dir"] / (generation + ".log")
            spec = {"edf_dir": str(self.paths["edf_dir"]), "output_dir": str(output),
                    "channels": channels, "options": options, "status_path": str(status)}
            spec_path = output / "generation_config.json"
            atomic_json(spec_path, spec)
            atomic_json(status, {"state": "running", "message": "Loading EDF", "completed": 0, "total": 0})
            environment = os.environ.copy()
            # Keep library caches/configuration out of the EEG source and user profile.
            for variable, child in (("NUMBA_CACHE_DIR", "numba"), ("MPLCONFIGDIR", "matplotlib"),
                                    ("_MNE_FAKE_HOME_DIR", "mne")):
                cache = self.paths["cache_dir"] / child
                cache.mkdir(parents=True, exist_ok=True)
                environment[variable] = str(cache)
            with log.open("w", encoding="utf-8") as stream:
                process = subprocess.Popen([sys.executable, "-B", str(APP_DIR / "wave_job.py"), str(spec_path)],
                    stdout=stream, stderr=subprocess.STDOUT, cwd=APP_DIR, env=environment,
                    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            self.job = {"process": process, "generation": generation, "status": status, "log": log}
            return self.job_status()

    def job_status(self):
        with self.lock:
            if not self.job:
                return {"state": "idle"}
            result = read_json(self.job["status"])
            code = self.job["process"].poll()
            if code is not None and result["state"] == "running":
                result.update(state="failed", message=f"Worker exited ({code}); see log")
            return {**result, "generation": self.job["generation"], "log": str(self.job["log"])}

    def cancel(self, context):
        with self.lock:
            self.require_context(context)
            if self.busy():
                self.job["process"].terminate()
                self.job["process"].wait(timeout=10)
                atomic_json(self.job["status"], {"state": "cancelled", "message": "Cancelled; partial files retained"})
            return self.job_status()


def re_generation(value):
    import re
    return isinstance(value, str) and re.fullmatch(r"generation_[a-f0-9]{32}", value) is not None
