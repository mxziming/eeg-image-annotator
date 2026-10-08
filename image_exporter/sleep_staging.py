"""Lightweight SouthData RML sleep-stage parsing without Detection dependencies."""

from pathlib import Path
from xml.etree import ElementTree

ALIASES = {
    "W": "WAKE", "WAKE": "WAKE", "SLEEPSTAGEW": "WAKE", "SLEEPSTAGE0": "WAKE", "STAGE0": "WAKE",
    "N1": "N1", "NREM1": "N1", "NONREM1": "N1", "SLEEPSTAGE1": "N1", "STAGE1": "N1",
    "N2": "N2", "NREM2": "N2", "NONREM2": "N2", "SLEEPSTAGE2": "N2", "STAGE2": "N2",
    "N3": "N3", "NREM3": "N3", "NONREM3": "N3", "SLEEPSTAGE3": "N3", "STAGE3": "N3",
    "N4": "N4", "NREM4": "N4", "NONREM4": "N4", "SLEEPSTAGE4": "N4", "STAGE4": "N4",
    "R": "REM", "REM": "REM", "SLEEPSTAGER": "REM", "SLEEPSTAGE5": "REM", "STAGE5": "REM",
    "MOVEMENT": "ART", "MOVEMENTTIME": "ART", "MT": "ART", "ART": "ART",
    "ARTEFACT": "ART", "ARTIFACT": "ART", "SLEEPSTAGE6": "ART", "STAGE6": "ART",
    "ACTIVE": "UNS", "UNKNOWN": "UNS", "UNS": "UNS", "UNSCORED": "UNS",
    "NOTSCORED": "UNS", "SLEEPSTAGE": "UNS", "SLEEPSTAGE9": "UNS", "STAGE9": "UNS",
}


def _local_name(tag):
    return str(tag).rsplit("}", 1)[-1]


def normalize_stage(value):
    key = "".join(character for character in str(value).upper() if character.isalnum())
    if key not in ALIASES:
        raise ValueError(f"Unknown sleep-stage label: {value!r}")
    return ALIASES[key]


def load_sleep_stages(stage_file, *, scorer="user", recording_duration_sec=None):
    path = Path(stage_file).expanduser().resolve()
    if not path.is_file():
        raise FileNotFoundError(f"Sleep-stage file not found: {path}")
    scorer = str(scorer).strip().casefold()
    if scorer not in {"user", "machine", "auto"}:
        raise ValueError("scorer must be 'user', 'machine', or 'auto'")
    choices = (("UserStaging", "user"), ("MachineStaging", "machine"))
    if scorer == "user":
        choices = choices[:1]
    elif scorer == "machine":
        choices = choices[1:]
    root = ElementTree.parse(path).getroot()
    rows = []
    resolved_scorer = ""
    for container_name, scorer_name in choices:
        found = []
        for container in root.iter():
            if _local_name(container.tag) != container_name:
                continue
            for stage in container.iter():
                if _local_name(stage.tag) == "Stage" and {"Start", "Type"} <= stage.attrib.keys():
                    found.append((float(stage.attrib["Start"]), normalize_stage(stage.attrib["Type"])))
        if found:
            rows = found
            resolved_scorer = scorer_name
            break
    if not rows:
        raise ValueError(f"No {scorer} sleep stages found in {path}")
    transitions = {}
    for start, label in rows:
        if start < 0:
            raise ValueError("Sleep-stage onset cannot be negative")
        transitions[start] = label
    ordered = sorted(transitions.items())
    intervals = []
    for index, (start, label) in enumerate(ordered):
        end = ordered[index + 1][0] if index + 1 < len(ordered) else recording_duration_sec
        if end is not None and end <= start:
            raise ValueError("Sleep-stage transitions must be strictly increasing")
        intervals.append({"start": start, "end": end, "stage": label, "scorer": resolved_scorer})
    return intervals


def stage_at_time(intervals, time_sec, default="UNS"):
    for interval in reversed(intervals):
        end = interval["end"]
        if interval["start"] <= time_sec and (end is None or time_sec < end):
            return interval["stage"]
    return normalize_stage(default)
