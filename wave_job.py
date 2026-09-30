"""Subprocess entry point; never imports or executes detection pipelines."""
import sys
import time
import traceback

from project_workflow import atomic_json, read_json


def main(filename):
    spec = read_json(filename)
    status = spec["status_path"]
    try:
        from eeg_io import load_eeg_raw
        from wave_image_export import export_wave_images
        raw = load_eeg_raw(spec["edf_dir"], spec["channels"], preload=False)
        try:
            last_progress = {"done": None, "time": 0.0}
            def report_progress(done, total):
                now = time.monotonic()
                if done != total and done % 5 and now - last_progress["time"] < 2.0:
                    return
                last_progress["done"] = done
                last_progress["time"] = now
                atomic_json(status, {
                    "state": "running",
                    "completed": done,
                    "total": total,
                    "message": "Generating images",
                })
            manifest = export_wave_images(raw, spec["output_dir"], **spec["options"],
                progress=report_progress)
        finally:
            raw.close()
        atomic_json(status, {"state": "complete", "manifest": str(manifest), "message": "Images ready"})
        return 0
    except Exception as error:
        traceback.print_exc()
        atomic_json(status, {"state": "failed", "message": str(error)})
        return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1]))
