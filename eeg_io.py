"""Read-only EDF loading for annotation images, independent of Detection."""
from pathlib import Path
import re

CHANNELS = ("F3M2", "F4M1", "C3M2", "C4M1", "O1M2", "O2M1")


def normalize_channel(value):
    name = re.sub(r"[^A-Z0-9]", "", str(value).upper().removeprefix("EEG"))
    name = re.sub(r"A([12])$", r"M\1", name)
    name = re.sub(r"^(F3|C3|O1)CLE$", r"\1M2", name)
    name = re.sub(r"^(F4|C4|O2)CLE$", r"\1M1", name)
    if name not in CHANNELS:
        raise ValueError(f"Unsupported EEG channel: {value}")
    return name


def find_edf_files(folder):
    root = Path(folder).expanduser().resolve()
    if not root.is_dir():
        raise ValueError(f"EDF directory does not exist: {root}")
    paths = [p for p in root.rglob("*") if p.is_file() and p.suffix.lower() == ".edf"]
    if not paths:
        raise ValueError("No EDF files found")
    # Preserve SouthData raw chunk ordering, excluding derived EDFs.
    indexed = [(int(m.group(1)), p) for p in paths
               if (m := re.search(r"\[(\d{3})\]\.edf$", p.name, re.I))]
    if indexed:
        if len({i for i, _ in indexed}) != len(indexed):
            raise ValueError("Repeated EDF chunk numbers; select one recording directory")
        return [p for _, p in sorted(indexed)]
    if len(paths) == 1:
        return paths
    raise ValueError("Multiple EDF files without [NNN] chunk order; select a single recording")


def load_eeg_raw(folder, channels, *, preload=False):
    import mne
    requested = [normalize_channel(c) for c in channels]
    if not requested or len(set(requested)) != len(requested):
        raise ValueError("Choose unique, nonempty EEG channels")
    raws = []
    try:
        for path in find_edf_files(folder):
            raw = mne.io.read_raw_edf(path, preload=preload, verbose="ERROR")
            raws.append(raw)
            available = {}
            for label in raw.ch_names:
                try:
                    key = normalize_channel(label)
                except ValueError:
                    continue
                if key in available:
                    raise ValueError(f"Ambiguous channel {key} in {path.name}")
                available[key] = label
            missing = set(requested) - available.keys()
            if missing:
                raise ValueError(f"{path.name}: missing channels {sorted(missing)}")
            raw.pick([available[c] for c in requested])
            raw.reorder_channels([available[c] for c in requested])
            raw.rename_channels({available[c]: c for c in requested})
        return mne.concatenate_raws(raws, preload=preload, verbose="ERROR")
    except Exception:
        for raw in raws:
            raw.close()
        raise
