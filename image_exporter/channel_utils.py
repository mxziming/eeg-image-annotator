"""Canonical channel names shared by the standalone exporter and manifest."""

ALIASES = {
    "F3A2": "F3M2", "F3M2": "F3M2", "F3CLE": "F3M2",
    "F4A1": "F4M1", "F4M1": "F4M1", "F4CLE": "F4M1",
    "C3A2": "C3M2", "C3M2": "C3M2", "C3CLE": "C3M2",
    "C4A1": "C4M1", "C4M1": "C4M1", "C4CLE": "C4M1",
    "O1A2": "O1M2", "O1M2": "O1M2", "O1CLE": "O1M2",
    "O2A1": "O2M1", "O2M1": "O2M1", "O2CLE": "O2M1",
    "LOC": "LOC", "LOCA2": "LOC", "EOGLOCA2": "LOC",
    "ROC": "ROC", "ROCA2": "ROC", "EOGROCA2": "ROC",
}


def normalize_channel(value):
    text = "".join(character for character in str(value).upper() if character.isalnum())
    if text.startswith("EEG"):
        text = text[3:]
    try:
        return ALIASES[text]
    except KeyError as error:
        raise ValueError(f"Unsupported annotation-image channel: {value!r}") from error
