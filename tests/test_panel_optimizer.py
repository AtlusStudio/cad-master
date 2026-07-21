import unittest

from src.config import MaterialConfig
from src.panel_optimizer import layout_wall, optimize_span
from src.wall_detector import OpeningSpan, WallSegment


class PanelOptimizerTest(unittest.TestCase):
    def test_exact_standard_layout_includes_joint_gap(self) -> None:
        sizes = optimize_span(2323, widths=(1160, 1180), joint_gap=3)
        self.assertEqual([(item.width, item.standard_width) for item in sizes], [(1160, 1160), (1160, 1160)])

    def test_nonstandard_panel_is_rounded_to_five_millimetres(self) -> None:
        sizes = optimize_span(2000, joint_gap=3)
        self.assertEqual([(item.width, item.standard_width) for item in sizes], [(1180, 1180), (815, None)])

    def test_cut_panels_are_symmetric_when_they_meet_the_minimum_width(self) -> None:
        sizes = optimize_span(4000, joint_gap=3)
        self.assertEqual([item.width for item in sizes], [225, 1180, 1180, 1180, 225])

    def test_exact_single_standard_panel_is_not_cut_for_primary(self) -> None:
        sizes = optimize_span(1197, widths=(580, 1180, 1197), joint_gap=3)
        self.assertEqual([(item.width, item.standard_width) for item in sizes], [(1197, 1197)])

    def test_layout_offsets_leave_three_millimetre_joint(self) -> None:
        wall = WallSegment("W0001", (0, 0), (2000, 0), 50)
        panels = layout_wall(wall, MaterialConfig())
        self.assertEqual(panels[1].start_offset - panels[0].end_offset, 3)

    def test_opening_does_not_restart_the_panel_grid(self) -> None:
        wall = WallSegment(
            "W0001",
            (0, 0),
            (5450, 0),
            50,
            (OpeningSpan(1800, 3000, "window"), OpeningSpan(3150, 4150, "door")),
        )
        panels = layout_wall(wall, MaterialConfig())
        self.assertEqual([panel.width for panel in panels], [1180, 1180, 1180, 1180, 720])

    def test_primary_width_wins_over_more_auxiliary_standard_panels(self) -> None:
        sizes = optimize_span(11250, joint_gap=3)

        self.assertEqual([item.width for item in sizes], [1180] * 9 + [605])


if __name__ == "__main__":
    unittest.main()
