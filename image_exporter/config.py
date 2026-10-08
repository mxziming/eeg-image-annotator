"""User-editable defaults for standalone EEG annotation-image generation."""

from pathlib import Path

DATASET_NAME = "SouthData"
RECORDING_NAME = "00000039-152400 何克文 正常"
EDF_FOLDER = Path(r"E:\Dataset\SouthData") / RECORDING_NAME
IMAGE_LIBRARY_ROOT = Path(r"E:\EEGAnnotationData")

CHANNELS = ("F3M2", "F4M1", "C3M2", "C4M1", "O1M2", "O2M1", "LOC", "ROC")
EPOCH_LENGTH_SEC = 30.0
EPOCH_BASE = 1
START_EPOCH = None
END_EPOCH = None

# Optional SouthData RML staging file. Keep None when no staging is available.
SLEEP_STAGE_FILE = EDF_FOLDER / "00000039-152400.rml"
SLEEP_STAGE_SCORER = "user"  # user, machine, or auto

DISPLAY_FILTER = (0.3, 35.0)  # None disables display filtering.
FILTER_METHOD = "iir2"        # fir, iir2, iir4, or iir6.
AMPLITUDE_UV = 100.0          # Minimum shared absolute y-axis limit per epoch.
DPI = 150
FIGURE_WIDTH_IN = 25.0
CHANNEL_HEIGHT_IN = 1.5
TOP_MARGIN_IN = 0.65
BOTTOM_MARGIN_IN = 0.85
CHANNEL_GAP_IN = 0.12
