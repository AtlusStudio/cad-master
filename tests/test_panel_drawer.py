import unittest

import ezdxf

from src.dxf_reader import ensure_panel_layers
from src.panel_drawer import draw_wall_layout
from src.panel_optimizer import Panel
from src.wall_detector import WallSegment


class PanelDrawerTest(unittest.TestCase):
    def test_panel_draws_only_joint_across_wall(self) -> None:
        doc = ezdxf.new()
        ensure_panel_layers(doc)
        wall = WallSegment("W0001", (0, 0), (2363, 0), 100)
        panels = [
            Panel("W0001", 0, 1180, 1180, 1180),
            Panel("W0001", 1183, 2363, 1180, 1180),
        ]

        draw_wall_layout(doc, wall, panels, [])

        lines = doc.modelspace().query('LINE[layer=="PANEL_JOINT"]')
        self.assertEqual(len(lines), 1)
        self.assertEqual(tuple(lines.first.dxf.start)[:2], (1181.5, -50))
        self.assertEqual(tuple(lines.first.dxf.end)[:2], (1181.5, 50))

        labels = doc.modelspace().query('MTEXT[layer=="PANEL_TEXT"]')
        self.assertEqual(len(labels), 2)
        self.assertEqual(tuple(labels.first.dxf.insert)[:2], (590, 150))
        self.assertEqual(labels.first.dxf.char_height, 125)
        self.assertEqual(labels.first.text, "1180")

    def test_vertical_wall_uses_vertical_width_labels(self) -> None:
        doc = ezdxf.new()
        ensure_panel_layers(doc)
        wall = WallSegment("W0001", (0, 0), (0, 1180), 100)

        draw_wall_layout(doc, wall, [Panel("W0001", 0, 1180, 1180, 1180)], [])

        label = doc.modelspace().query('MTEXT[layer=="PANEL_TEXT"]').first
        self.assertEqual(label.text, "1180")
        self.assertEqual(label.dxf.rotation, 90)
