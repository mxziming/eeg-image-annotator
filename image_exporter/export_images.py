"""Generate clean annotation PNGs and a geometry-complete manifest outside the UI."""

from __future__ import annotations

import argparse
from datetime import datetime
import json
from pathlib import Path
import uuid

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.ticker import MultipleLocator
import numpy as np

from . import config as defaults
from .channel_utils import normalize_channel
from .recording_io import find_raw_edf_files


def _filter_label(display_filter, method):
    return "unfiltered" if display_filter is None else str(method)


def _epoch_title(epoch, stage, display_filter, method):
    return f"EPOCH {epoch}|{stage}|{_filter_label(display_filter, method)}"


def _channel_color(name):
    return "#2563eb" if name in {"LOC", "ROC"} else "#202020"


def _style_time_axis(axis):
    axis.xaxis.set_major_locator(MultipleLocator(5.0))
    axis.xaxis.set_minor_locator(MultipleLocator(1.0))
    axis.grid(axis="x", which="minor", color="#d8dee3", linewidth=0.35)
    axis.grid(axis="x", which="major", color="#9aa5ad", linewidth=0.8)


def _epoch_amplitude(data, visible, minimum_uv):
    visible_data = np.asarray(data)[:, np.asarray(visible, dtype=bool)]
    finite = np.abs(visible_data[np.isfinite(visible_data)])
    peak = float(finite.max()) if finite.size else 0.0
    return max(float(minimum_uv), peak)


def _load_stages(stage_file, scorer, duration):
    if stage_file is None:
        return None
    from .sleep_staging import load_sleep_stages

    return load_sleep_stages(
        Path(stage_file).expanduser().resolve(), scorer=scorer,
        recording_duration_sec=duration,
    )


def _stage_at_time(stages, time_sec):
    from .sleep_staging import stage_at_time

    return stage_at_time(stages, time_sec)


def _resolve_channels(folder: Path, requested: list[str]):
    import mne

    paths = find_raw_edf_files(folder)
    probe = mne.io.read_raw_edf(paths[0], preload=False, infer_types=False, verbose="ERROR")
    available = {}
    for raw_name in probe.ch_names:
        try:
            available.setdefault(normalize_channel(raw_name), raw_name)
        except ValueError:
            continue
    canonical = [normalize_channel(name) for name in requested]
    missing = [name for name in canonical if name not in available]
    if missing:
        raise ValueError(f"Requested channels are absent from EDF: {missing}")
    selected = [available[name] for name in canonical]
    raws = [mne.io.read_raw_edf(path, include=selected, preload=False,
        infer_types=False, verbose="ERROR") for path in paths]
    raw = mne.concatenate_raws(raws, preload=False, verbose="ERROR")
    raw.rename_channels({source: target for source, target in zip(selected, canonical)})
    return raw, canonical


def _filter(data, sfreq, display_filter, method):
    if display_filter is None:
        return data
    import mne

    aliases = {"fir": ("fir", {}), "iir2": ("iir", {"iir_params": {"order": 2, "ftype": "butter"}}),
        "iir4": ("iir", {"iir_params": {"order": 4, "ftype": "butter"}}),
        "iir6": ("iir", {"iir_params": {"order": 6, "ftype": "butter"}})}
    if method not in aliases:
        raise ValueError(f"Unknown filter method: {method}")
    mne_method, kwargs = aliases[method]
    return mne.filter.filter_data(data, sfreq, display_filter[0], display_filter[1],
        method=mne_method, phase="zero", verbose="ERROR", **kwargs)


def export_images(*, edf_folder, output_root, dataset_name, recording_name, channels,
                  epoch_length_sec, epoch_base, start_epoch, end_epoch, display_filter,
                  filter_method, amplitude_uv, sleep_stage_file, sleep_stage_scorer,
                  dpi, figure_width_in, channel_height_in,
                  top_margin_in, bottom_margin_in, channel_gap_in):
    folder = Path(edf_folder).expanduser().resolve()
    raw, names = _resolve_channels(folder, list(channels))
    try:
        sfreq = float(raw.info["sfreq"])
        duration = raw.n_times / sfreq
        stages = _load_stages(sleep_stage_file, sleep_stage_scorer, duration)
        final_epoch = epoch_base + int(np.ceil(duration / epoch_length_sec)) - 1
        first_epoch = epoch_base if start_epoch is None else int(start_epoch)
        last_epoch = final_epoch if end_epoch is None else min(int(end_epoch), final_epoch)
        image_set_id = "set_" + datetime.now().strftime("%Y%m%d_%H%M%S") + "_" + uuid.uuid4().hex[:8]
        root = Path(output_root).expanduser().resolve() / dataset_name / recording_name / "image_sets" / image_set_id
        image_dir = root / "images"
        image_dir.mkdir(parents=True, exist_ok=False)
        count = len(names)
        height = top_margin_in + bottom_margin_in + count * channel_height_in + max(count - 1, 0) * channel_gap_in
        manifest = {"schemaVersion": 2, "kind": "eeg-annotation-images", "imageSetId": image_set_id,
            "datasetName": dataset_name, "recordingName": recording_name,
            "epochLengthSec": epoch_length_sec, "epochBase": epoch_base, "dpi": dpi,
            "render": {"displayFilter": display_filter, "filterMethod": filter_method,
                "amplitudeUv": amplitude_uv, "figureWidthIn": figure_width_in,
                "channelHeightIn": channel_height_in,
                "sleepStageFile": None if sleep_stage_file is None else str(Path(sleep_stage_file).resolve()),
                "sleepStageScorer": sleep_stage_scorer}, "channels": [], "images": []}
        for epoch in range(first_epoch, last_epoch + 1):
            start = (epoch - epoch_base) * epoch_length_sec
            stop = min(start + epoch_length_sec, duration)
            first = max(0, int(round((start - 20) * sfreq)))
            last = min(raw.n_times, int(round((stop + 20) * sfreq)))
            data = _filter(raw.get_data(start=first, stop=last) * 1e6, sfreq, display_filter, filter_method)
            times = np.arange(first, last) / sfreq
            visible = (times >= start) & (times < stop)
            epoch_amplitude = _epoch_amplitude(data, visible, amplitude_uv)
            stage = "UNSTAGED" if stages is None else _stage_at_time(stages, start)
            fig, axes = plt.subplots(count, 1, sharex=True, squeeze=False,
                figsize=(figure_width_in, height), dpi=dpi)
            fig.subplots_adjust(left=0.065, right=0.99,
                top=1 - top_margin_in / height, bottom=bottom_margin_in / height,
                hspace=channel_gap_in / channel_height_in)
            try:
                fig.suptitle(_epoch_title(epoch, stage, display_filter, filter_method), y=0.995)
                for axis, signal, name in zip(axes[:, 0], data, names):
                    color = _channel_color(name)
                    axis.plot(times[visible] - start, signal[visible], color=color, linewidth=0.6)
                    axis.set_xlim(0, epoch_length_sec)
                    axis.set_ylim(epoch_amplitude, -epoch_amplitude)
                    axis.set_ylabel(name, rotation=0, ha="right", va="center")
                    _style_time_axis(axis)
                axes[-1, 0].set_xlabel("Seconds from window start")
                fig.canvas.draw()
                width_px, height_px = fig.canvas.get_width_height()
                if not manifest["channels"]:
                    for axis, name in zip(axes[:, 0], names):
                        box = axis.get_position()
                        manifest["channels"].append({"name": name,
                            "kind": "EOG" if name in {"LOC", "ROC"} else "EEG",
                            "topPct": (1 - box.y1) * 100, "bottomPct": (1 - box.y0) * 100})
                    first_box = axes[0, 0].get_position()
                    manifest["canvas"] = {"widthPx": width_px, "heightPx": height_px,
                        "plotLeftPct": first_box.x0 * 100, "plotRightPct": first_box.x1 * 100}
                filename = f"epoch_{epoch:06d}.png"
                fig.savefig(image_dir / filename, dpi=dpi)
            finally:
                plt.close(fig)
            manifest["images"].append({"name": f"images/{filename}", "epoch": epoch,
                "windowStart": start, "windowDuration": epoch_length_sec,
                "dataDuration": stop - start, "sleepStage": stage,
                "amplitudeUv": epoch_amplitude,
                "widthPx": width_px, "heightPx": height_px})
        (root / "render_config.json").write_text(json.dumps({
            "edfFolder": str(folder), "channels": names, "displayFilter": display_filter,
            "filterMethod": filter_method,
            "sleepStageFile": None if sleep_stage_file is None else str(Path(sleep_stage_file).resolve()),
            "sleepStageScorer": sleep_stage_scorer,
            "dpi": dpi}, ensure_ascii=False, indent=2), encoding="utf-8")
        manifest_path = root / "images_manifest.json"
        manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
        return manifest_path
    finally:
        raw.close()


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--edf-folder", type=Path, default=defaults.EDF_FOLDER)
    parser.add_argument("--output-root", type=Path, default=defaults.IMAGE_LIBRARY_ROOT)
    parser.add_argument("--dataset-name", default=defaults.DATASET_NAME)
    parser.add_argument("--recording-name", default=defaults.RECORDING_NAME)
    parser.add_argument("--channels", nargs="+", default=list(defaults.CHANNELS))
    parser.add_argument("--sleep-stage-file", type=Path, default=defaults.SLEEP_STAGE_FILE)
    parser.add_argument("--sleep-stage-scorer", choices=("user", "machine", "auto"),
                        default=defaults.SLEEP_STAGE_SCORER)
    args = parser.parse_args(argv)
    print(export_images(edf_folder=args.edf_folder, output_root=args.output_root,
        dataset_name=args.dataset_name, recording_name=args.recording_name,
        channels=args.channels, epoch_length_sec=defaults.EPOCH_LENGTH_SEC,
        epoch_base=defaults.EPOCH_BASE, start_epoch=defaults.START_EPOCH,
        end_epoch=defaults.END_EPOCH, display_filter=defaults.DISPLAY_FILTER,
        filter_method=defaults.FILTER_METHOD, amplitude_uv=defaults.AMPLITUDE_UV,
        sleep_stage_file=args.sleep_stage_file, sleep_stage_scorer=args.sleep_stage_scorer,
        dpi=defaults.DPI, figure_width_in=defaults.FIGURE_WIDTH_IN,
        channel_height_in=defaults.CHANNEL_HEIGHT_IN, top_margin_in=defaults.TOP_MARGIN_IN,
        bottom_margin_in=defaults.BOTTOM_MARGIN_IN, channel_gap_in=defaults.CHANNEL_GAP_IN))


if __name__ == "__main__":
    main()
