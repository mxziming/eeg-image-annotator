"""Local annotation projects backed by externally generated image sets."""
from __future__ import annotations
import json
import os
from pathlib import Path
import threading
import time
import uuid

def read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))

def atomic_json(path, data):
    atomic_text(path, json.dumps(data, ensure_ascii=False, indent=2))

def atomic_text(path, text, backup=False):
    path = Path(path); path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    try:
        with temporary.open("w", encoding="utf-8", newline="") as stream:
            stream.write(text); stream.flush(); os.fsync(stream.fileno())
        if backup and path.exists():
            atomic_text(path.with_name(path.stem + ".previous" + path.suffix), path.read_text(encoding="utf-8"))
        for attempt in range(25):
            try: os.replace(temporary, path); break
            except PermissionError:
                if attempt == 24: raise
                time.sleep(0.04 + attempt * 0.01)
    finally:
        if temporary.exists(): temporary.unlink()

def _resolve(root, value):
    path = Path(value).expanduser()
    return (root / path).resolve() if not path.is_absolute() else path.resolve()

class ProjectWorkflow:
    def __init__(self):
        self.path = None; self.config = None; self.paths = {}; self.lock = threading.RLock()

    def open(self, filename):
        with self.lock:
            path = Path(filename).expanduser().resolve()
            if path.is_dir(): path /= "project.json"
            config = read_json(path)
            if config.get("schema_version") not in {1, 2} or not config.get("project_id"):
                raise ValueError("Unsupported project configuration")
            values = config.get("paths", {}); root = path.parent
            images_value = values.get("image_sets_dir") or values.get("images_dir")
            if not images_value: raise ValueError("Project does not define an external image-set directory")
            self.path, self.config = path, config
            self.paths = {"image_sets_dir": _resolve(root, images_value),
                          "annotations_dir": _resolve(root, values.get("annotations_dir", "annotations"))}
            return self.info()

    def create(self, payload):
        with self.lock:
            root = Path(payload["project_dir"]).expanduser().resolve()
            image_sets = Path(payload["image_sets_dir"]).expanduser().resolve()
            if not image_sets.is_dir(): raise ValueError("External image-set directory does not exist")
            path = root / "project.json"
            if path.exists(): raise ValueError("Project already exists; use Open project")
            annotations = payload.get("annotations_dir") or "annotations"
            config = {"schema_version": 2, "project_id": uuid.uuid4().hex, "active_image_set": None,
                      "paths": {"image_sets_dir": str(image_sets), "annotations_dir": annotations}}
            root.mkdir(parents=True, exist_ok=True); _resolve(root, annotations).mkdir(parents=True, exist_ok=True)
            atomic_json(path, config); return self.open(path)

    def image_sets(self):
        root = self.paths.get("image_sets_dir")
        if not root or not root.is_dir(): return []
        candidates = [root] if (root / "images_manifest.json").is_file() else list(root.iterdir())
        sets = []
        for directory in candidates:
            manifest = directory / "images_manifest.json"
            if not directory.is_dir() or not manifest.is_file(): continue
            try:
                payload = read_json(manifest); name = payload.get("imageSetId") or directory.name
                sets.append({"id": name, "directory": str(directory), "manifest": str(manifest),
                             "datasetName": payload.get("datasetName", ""),
                             "recordingName": payload.get("recordingName", "")})
            except (OSError, ValueError, json.JSONDecodeError): continue
        return sorted(sets, key=lambda item: item["id"])

    def active_set(self):
        active = self.config.get("active_image_set") if self.config else None
        return next((item for item in self.image_sets() if item["id"] == active), None)

    def generation_dir(self):
        active = self.active_set(); return Path(active["directory"]) if active else None

    def context(self):
        return None if not self.config else self.config["project_id"] + ":" + (self.config.get("active_image_set") or "empty")

    def require_context(self, value):
        if not self.config or value != self.context(): raise ValueError("Project changed; reload before saving")

    def annotation_path(self, filename="working.json"):
        active = self.config.get("active_image_set") if self.config else None
        if not active: raise ValueError("Select an external image set first")
        return self.paths["annotations_dir"] / active / filename

    def info(self):
        if not self.config: return {"project": None}
        sets = self.image_sets()
        return {"project": self.config, "configPath": str(self.path),
                "paths": {key: str(value) for key, value in self.paths.items()},
                "context": self.context(), "imageSets": sets, "generations": [item["id"] for item in sets]}

    def activate(self, image_set_id, context):
        with self.lock:
            self.require_context(context)
            if image_set_id not in {item["id"] for item in self.image_sets()}:
                raise ValueError("External image set does not exist or has no valid manifest")
            self.config["active_image_set"] = image_set_id; self.config.pop("active_generation", None)
            atomic_json(self.path, self.config); return self.info()

    def save_state(self, payload):
        with self.lock:
            self.require_context(payload.get("context")); state = payload["state"]
            if not isinstance(state, dict) or not isinstance(state.get("events"), list):
                raise ValueError("Invalid annotation state")
            target = self.annotation_path()
            atomic_text(target, json.dumps(state, ensure_ascii=False, indent=2), backup=target.exists())
            return {"ok": True, "path": str(target)}
