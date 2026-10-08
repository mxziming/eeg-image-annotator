from __future__ import annotations

import hashlib
import json
import mimetypes
import os
import re
import argparse
import secrets
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit
from project_workflow import ProjectWorkflow, read_json, atomic_text


APP_DIR = Path(__file__).resolve().parent
IMAGE_DIR = Path(os.environ.get("EEG_IMAGE_DIR", r"E:\Visualizations\SouthData_39_0.3_4"))
CSV_PATH = Path(os.environ.get("EEG_CSV_PATH", r"E:\SouthData_39_0.3_4.csv"))
DATASET_NAME = os.environ.get("EEG_DATASET_NAME", "SouthData_39")
PORT = int(os.environ.get("EEG_ANNOTATOR_PORT", "8765"))
WORKFLOW = ProjectWorkflow()
API_TOKEN = secrets.token_urlsafe(32)


def active_image_dir():
    if WORKFLOW.config:
        return WORKFLOW.generation_dir() or APP_DIR / "__no_generation__"
    return IMAGE_DIR


def current_config():
    directory = active_image_dir()
    manifest_path = directory / "images_manifest.json"
    manifest = read_json(manifest_path) if manifest_path.is_file() else None
    csv_path = (WORKFLOW.annotation_path("exports/annotations.csv")
                if WORKFLOW.generation_dir() else "先加载外部底图" if WORKFLOW.config else CSV_PATH)
    return {"datasetName": (manifest.get("datasetName") if manifest else None) or
            (manifest["images"][0].get("datasetName", DATASET_NAME) if manifest and manifest.get("images") else DATASET_NAME),
            "imageDir": str(directory), "csvPath": str(csv_path), "overlapThreshold": 0.5,
            "projectContext": WORKFLOW.context(),
            "imageSet": WORKFLOW.config.get("active_image_set") if WORKFLOW.config else None,
            "manifest": manifest}

IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".tif", ".tiff"}


def natural_key(text: str) -> list[object]:
    return [int(part) if part.isdigit() else part.lower() for part in re.split(r"(\d+)", text)]


def image_inventory() -> list[dict[str, object]]:
    directory = active_image_dir()
    if not directory.exists():
        return []

    files = [
        path
        for path in directory.rglob("*")
        if path.is_file() and path.suffix.lower() in IMAGE_EXTENSIONS
    ]
    files.sort(key=lambda path: natural_key(str(path.relative_to(directory))))

    images = []
    for path in files:
        relative_path = path.relative_to(directory).as_posix()
        image_id = hashlib.sha1(((WORKFLOW.context() or "") + relative_path).encode("utf-8")).hexdigest()[:16]
        images.append(
            {
                "id": image_id,
                "name": path.name,
                "relativePath": relative_path,
                "size": path.stat().st_size,
                "type": mimetypes.guess_type(path.name)[0] or "application/octet-stream",
            }
        )
    return images


def resolve_image(image_id: str) -> Path | None:
    for item in image_inventory():
        if item["id"] == image_id:
            path = (active_image_dir() / str(item["relativePath"])).resolve()
            try:
                path.relative_to(active_image_dir().resolve())
            except ValueError:
                return None
            return path
    return None


def choose_directory(initial: str = "", title: str = "选择文件夹") -> str:
    result: dict[str, str | Exception] = {}

    def worker() -> None:
        try:
            import tkinter as tk
            from tkinter import filedialog

            root = tk.Tk()
            root.withdraw()
            root.attributes("-topmost", True)
            selected = filedialog.askdirectory(
                parent=root,
                title=title,
                initialdir=initial if initial and Path(initial).is_dir() else None,
                mustexist=False,
            )
            root.destroy()
            result["path"] = selected or ""
        except Exception as error:
            result["error"] = error

    thread = threading.Thread(target=worker, daemon=True)
    thread.start()
    thread.join()
    if "error" in result:
        raise result["error"]  # type: ignore[misc]
    return str(result.get("path", ""))


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt: str, *args: object) -> None:
        print(f"{self.address_string()} - {fmt % args}")

    def do_GET(self) -> None:
        if urlsplit("http://" + self.headers.get("Host", "")).hostname not in ("127.0.0.1", "localhost", "::1"):
            return self.send_error(403)
        request_path = urlsplit(self.path).path
        if request_path == "/workflow.js":
            return self.serve_static(APP_DIR / "workflow.js")
        if request_path == "/api/project":
            return self.send_json(WORKFLOW.info())
        if request_path == "/" or request_path == "/index.html":
            return self.serve_index()
        if request_path == "/styles.css":
            return self.serve_static(APP_DIR / "styles.css")
        if request_path == "/app.js":
            return self.serve_static(APP_DIR / "app.js")
        if request_path == "/event-geometry.js":
            return self.serve_static(APP_DIR / "event-geometry.js")
        if request_path == "/api/config":
            return self.send_json(current_config())
        if request_path == "/api/images":
            return self.send_json({"images": image_inventory()})
        if request_path.startswith("/api/image/"):
            image_id = unquote(request_path.removeprefix("/api/image/"))
            path = resolve_image(image_id)
            if not path or not path.exists():
                return self.send_error(404, "Image not found")
            return self.serve_static(path)
        return self.send_error(404, "Not found")

    def serve_index(self) -> None:
        try:
            html = (APP_DIR / "index.html").read_text(encoding="utf-8")
        except OSError:
            return self.send_error(404, "File not found")

        state_path = WORKFLOW.annotation_path() if WORKFLOW.generation_dir() else None
        bootstrap = {
            "config": current_config(),
            "token": API_TOKEN,
            "savedState": read_json(state_path) if state_path and state_path.is_file() else None,
            "images": image_inventory(),
        }
        encoded_bootstrap = json.dumps(bootstrap, ensure_ascii=False).replace("<", "\\u003c")
        bootstrap_script = (
            "<script>"
            "window.__EEG_SERVER_BOOTSTRAP__ = "
            f"{encoded_bootstrap}"
            ";</script>"
        )
        app_version = int((APP_DIR / "app.js").stat().st_mtime)
        html = html.replace(
            '<script src="app.js"></script>',
            f"{bootstrap_script}\n    <script src=\"app.js?v={app_version}\"></script>",
        )
        data = html.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self) -> None:
        if self.headers.get("X-EEG-Token") != API_TOKEN:
            return self.send_json({"error": "Reload the local application before submitting"}, 403)
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 50 * 1024 * 1024:
                raise ValueError("Invalid request size (maximum 50 MB)")
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            if self.path in ("/api/project/create", "/api/project/open"):
                if payload.get("context") != WORKFLOW.context():
                    raise ValueError("Project changed; reload this page")
                with WORKFLOW.lock:
                    result = (WORKFLOW.create(payload) if self.path.endswith("create")
                              else WORKFLOW.open(payload["path"]))
                return self.send_json(result)
            if self.path == "/api/project/activate":
                return self.send_json(WORKFLOW.activate(payload["imageSet"], payload.get("context")))
            if self.path == "/api/project/save":
                return self.send_json(WORKFLOW.save_state(payload))
            if self.path == "/api/select-directory":
                return self.send_json({"path": choose_directory(payload.get("initial", ""), payload.get("title", "选择文件夹"))})
            if self.path != "/api/save-csv":
                return self.send_error(404, "Not found")
            csv_text = payload["csv"]
            if not isinstance(csv_text, str):
                raise ValueError("csv must be a string")
            with WORKFLOW.lock:
                if WORKFLOW.config:
                    WORKFLOW.require_context(payload.get("context"))
                    target = WORKFLOW.annotation_path("exports/annotations.csv")
                else:
                    target = CSV_PATH
                atomic_text(target, csv_text, backup=True)
            self.send_json({"ok": True, "csvPath": str(target)})
        except Exception as exc:
            self.send_json({"error": str(exc)}, 400)

    def serve_static(self, path: Path) -> None:
        try:
            data = path.read_bytes()
        except OSError:
            return self.send_error(404, "File not found")

        content_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def send_json(self, payload: dict[str, object], status=200) -> None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Local EEG annotation project server")
    parser.add_argument("--project", type=Path, help="project.json or its directory")
    parser.add_argument("--port", type=int, default=PORT)
    args = parser.parse_args()
    PORT = args.port
    if args.project:
        WORKFLOW.open(args.project)
    image_count = len(image_inventory())
    print(f"EEG image directory: {active_image_dir()}")
    print(f"CSV output path:      {current_config()['csvPath']}")
    print(f"Images found:         {image_count}")
    print(f"Open:                 http://localhost:{PORT}")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
