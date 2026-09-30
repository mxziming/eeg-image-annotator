"""Export clean EEG epoch images and their time manifest for manual annotation.
No detector or annotation file is executed/read. Filtering affects display only.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import re

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np


def export_wave_images(raw, output_dir, *, dataset_name="SouthData", recording_name="recording",
                       epoch_length_sec=30.0, epoch_base=1, start_epoch=None, end_epoch=None,
                       dpi=150, amplitude_uv=100.0, display_band=None, progress=None):
    """Use full epoch x-limits even for the final partial window (blank tail).

    This keeps time-to-percentage mapping and calibration constant across images.
    """
    from eeg_io import normalize_channel
    if not np.isfinite(epoch_length_sec) or epoch_length_sec <= 0:
        raise ValueError("epoch_length_sec must be positive and finite")
    if not isinstance(epoch_base, int) or dpi <= 0 or amplitude_uv <= 0:
        raise ValueError("Invalid epoch base, DPI or amplitude")
    sf = float(raw.info["sfreq"])
    duration = raw.n_times / sf
    final = epoch_base + int(np.ceil(duration / epoch_length_sec)) - 1
    start_epoch = epoch_base if start_epoch is None else start_epoch
    end_epoch = final if end_epoch is None else min(end_epoch, final)
    if start_epoch < epoch_base or end_epoch < start_epoch:
        raise ValueError("Invalid epoch range")
    names = [normalize_channel(c) for c in raw.ch_names]
    if len(set(names)) != len(names) or not names:
        raise ValueError("Input channels must be unique and nonempty")
    output = Path(output_dir).expanduser().resolve()
    if (output / "images_manifest.json").exists():
        raise FileExistsError("Output already contains a manifest; choose a new output directory")
    output.mkdir(parents=True, exist_ok=True)
    token = re.sub(r'[^\w.-]+', '_', f"{dataset_name}_{recording_name}")
    metadata = {"kind": "wave-images", "version": 1, "epochLengthSec": epoch_length_sec,
                "epochBase": epoch_base, "channels": names, "displayBand": display_band,
                "amplitudeUv": amplitude_uv, "images": []}
    for epoch in range(start_epoch, end_epoch + 1):
        start = (epoch - epoch_base) * epoch_length_sec
        stop = min(start + epoch_length_sec, duration)
        # Read padded data to reduce display-filter edge transients.
        pad = 20.0 if display_band else 0.0
        first = max(0, int(round((start - pad) * sf)))
        last = min(raw.n_times, int(round((stop + pad) * sf)))
        data = raw.get_data(start=first, stop=last) * 1e6
        if display_band:
            from scipy.signal import butter, sosfiltfilt
            low, high = display_band
            if not 0 < low < high < sf / 2:
                raise ValueError("display_band must lie within (0, Nyquist)")
            data = sosfiltfilt(butter(2, [low, high], btype="bandpass", fs=sf, output="sos"), data)
        times = np.arange(first, last) / sf
        view = (times >= start) & (times < stop)
        visible = data[:, view]
        finite = visible[np.isfinite(visible)]
        if finite.size:
            y_min = min(-amplitude_uv, float(np.min(finite)))
            y_max = max(amplitude_uv, float(np.max(finite)))
        else:
            y_min, y_max = -amplitude_uv, amplitude_uv
        height = max(4, 2 * len(names))
        fig, axes = plt.subplots(len(names), 1, figsize=(16, height), squeeze=False, sharex=True)
        fig.subplots_adjust(left=.065, right=.99, top=1 - .5 / height, bottom=.6 / height, hspace=.18)
        try:
            for ax, signal, name in zip(axes[:, 0], data, names):
                ax.plot(times[view] - start, signal[view], color="#202020", linewidth=.6)
                ax.set_xlim(0, epoch_length_sec)
                ax.set_ylim(y_min, y_max)
                ax.set_ylabel(f"{name}\nµV")
                ax.grid(alpha=.2)
            axes[-1, 0].set_xlabel("Seconds from window start")
            fig.suptitle(f"{recording_name} | Epoch {epoch} | Start {start:g} s")
            filename = f"{token}_epoch_{epoch:06d}_start_{start:010.3f}s.png"
            path = output / filename
            if path.exists():
                raise FileExistsError(f"Refusing to overwrite an existing image: {path}")
            fig.savefig(path, dpi=dpi)  # fixed canvas; no tight crop
        finally:
            plt.close(fig)
        metadata["images"].append({"name": filename, "datasetName": dataset_name,
            "recordingName": recording_name, "epoch": epoch, "windowStart": start,
            "windowDuration": epoch_length_sec, "dataDuration": stop - start,
            "displayYMinUv": y_min, "displayYMaxUv": y_max})
        if progress:
            progress(epoch - start_epoch + 1, end_epoch - start_epoch + 1)
    manifest = output / "images_manifest.json"
    manifest.write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")
    return manifest


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--edf-folder", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--channels", nargs="+", default=["F3M2", "F4M1", "C3M2", "C4M1", "O1M2", "O2M1"])
    parser.add_argument("--dataset-name", default="SouthData")
    parser.add_argument("--recording-name")
    parser.add_argument("--epoch-length-sec", type=float, default=30.)
    parser.add_argument("--epoch-base", type=int, default=1)
    parser.add_argument("--start-epoch", type=int)
    parser.add_argument("--end-epoch", type=int)
    parser.add_argument("--display-band", type=float, nargs=2, metavar=("LOW", "HIGH"))
    parser.add_argument("--amplitude-uv", type=float, default=100.)
    parser.add_argument("--dpi", type=int, default=150)
    args = parser.parse_args(argv)
    from eeg_io import load_eeg_raw
    raw = load_eeg_raw(args.edf_folder, args.channels, preload=False)
    try:
        print(export_wave_images(raw, args.output_dir, dataset_name=args.dataset_name,
            recording_name=args.recording_name or args.edf_folder.resolve().name,
            epoch_length_sec=args.epoch_length_sec, epoch_base=args.epoch_base,
            start_epoch=args.start_epoch, end_epoch=args.end_epoch, dpi=args.dpi,
            amplitude_uv=args.amplitude_uv, display_band=args.display_band))
    finally:
        raw.close()


if __name__ == "__main__":
    main()
