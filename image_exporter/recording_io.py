"""Minimal EDF discovery for the standalone image exporter."""

from pathlib import Path
import re
import warnings


def find_raw_edf_files(folder):
    root = Path(folder).expanduser().resolve()
    if not root.is_dir():
        raise NotADirectoryError(root)
    files = sorted(path.resolve() for path in root.rglob("*.edf"))
    if not files:
        raise FileNotFoundError(f"No EDF files found under {root}")
    pattern = re.compile(r"\[(\d{3})\]\.edf$", flags=re.IGNORECASE)
    indexed = [(int(match.group(1)), path) for path in files if (match := pattern.search(path.name))]
    if indexed:
        selected = {path for _, path in indexed}
        ignored = [path for path in files if path not in selected]
        if ignored:
            names = ", ".join(path.name for path in ignored)
            warnings.warn(
                f"Ignoring EDF files that are not primary [NNN].edf chunks: {names}",
                stacklevel=2,
            )
        indexed.sort(key=lambda item: item[0])
        indexes = [item[0] for item in indexed]
        if len(indexes) != len(set(indexes)):
            raise ValueError("EDF chunk indexes must be unique")
        return [path for _, path in indexed]
    if len(files) == 1:
        return files
    raise ValueError("Multiple EDF files require [NNN].edf indexes to define their order")
