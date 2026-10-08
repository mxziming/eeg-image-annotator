import tempfile
from pathlib import Path
import unittest

import matplotlib.pyplot as plt
import numpy as np

from image_exporter.channel_utils import normalize_channel
from image_exporter.export_images import (
    _channel_color, _epoch_amplitude, _epoch_title, _style_time_axis,
)
from image_exporter.recording_io import find_raw_edf_files
from image_exporter.sleep_staging import load_sleep_stages, stage_at_time


class StandaloneExporterTests(unittest.TestCase):
    def test_channel_aliases_are_self_contained(self):
        self.assertEqual(normalize_channel("EEG F3-A2"), "F3M2")
        self.assertEqual(normalize_channel("EOG LOC-A2"), "LOC")
        with self.assertRaises(ValueError):
            normalize_channel("ECG")

    def test_epoch_style_rules(self):
        visible = np.array([True, True, False])
        self.assertEqual(_epoch_amplitude([[20, -99, 900], [40, 80, -900]], visible, 100), 100)
        self.assertEqual(_epoch_amplitude([[20, -125, 0], [110, 80, 0]], visible, 100), 125)
        self.assertEqual(_epoch_title(145, "N2", (0.3, 35), "iir2"), "EPOCH 145|N2|iir2")
        self.assertEqual(_channel_color("LOC"), "#2563eb")
        self.assertEqual(_channel_color("ROC"), "#2563eb")
        self.assertEqual(_channel_color("C3M2"), "#202020")

    def test_time_grid(self):
        figure, axis = plt.subplots()
        try:
            _style_time_axis(axis)
            self.assertEqual(axis.xaxis.get_major_locator()._edge.step, 5.0)
            self.assertEqual(axis.xaxis.get_minor_locator()._edge.step, 1.0)
        finally:
            plt.close(figure)

    def test_indexed_edf_order_and_auxiliary_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "recording[002].edf").touch()
            (root / "recording[001].edf").touch()
            self.assertEqual([path.name for path in find_raw_edf_files(root)],
                             ["recording[001].edf", "recording[002].edf"])
            (root / "recording[001]-T.edf").touch()
            with self.assertWarnsRegex(UserWarning, "Ignoring EDF files"):
                selected = find_raw_edf_files(root)
            self.assertEqual([path.name for path in selected],
                             ["recording[001].edf", "recording[002].edf"])

    def test_rml_staging_without_detection(self):
        xml = """<Root><UserStaging><Stage Start="0" Type="Wake" />
          <Stage Start="30" Type="N2" /></UserStaging></Root>"""
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "stages.rml"
            path.write_text(xml, encoding="utf-8")
            stages = load_sleep_stages(path, recording_duration_sec=60)
            self.assertEqual(stage_at_time(stages, 10), "WAKE")
            self.assertEqual(stage_at_time(stages, 45), "N2")


if __name__ == "__main__":
    unittest.main()
