import unittest

from ezdxf.math import Vec2, is_point_in_polygon_2d

from src.ceiling_layout import calculate_ceiling_layout
from src.wall_detector import OpeningSpan, WallSegment


class CeilingLayoutTest(unittest.TestCase):
    def test_rectangle_ignores_internal_wall_and_opening(self) -> None:
        walls = (
            WallSegment("W1", (0, 0), (3600, 0), 50, (OpeningSpan(500, 1500, "door"),)),
            WallSegment("W2", (3600, 0), (3600, 4800), 50),
            WallSegment("W3", (3600, 4800), (0, 4800), 50),
            WallSegment("W4", (0, 4800), (0, 0), 50),
            WallSegment("W5", (1800, 0), (1800, 4800), 50),
        )

        layout = calculate_ceiling_layout(walls)

        self.assertEqual(len(layout.panels), 8)
        self.assertEqual(
            (round(min(x for x, _ in layout.boundary)), round(max(x for x, _ in layout.boundary))),
            (25, 3575),
        )
        full_panels = [
            panel
            for panel in layout.panels
            if round(panel.width) == 1180 and round(panel.length) == 3000
        ]
        self.assertTrue(full_panels)
        self.assertTrue(all(panel.width <= 1180 and panel.length <= 3000 for panel in layout.panels))

    def test_concave_boundary_clips_every_panel_inside(self) -> None:
        points = ((0, 0), (4800, 0), (4800, 2400), (2400, 2400), (2400, 4800), (0, 4800))
        walls = tuple(
            WallSegment(f"W{index}", start, end, 50)
            for index, (start, end) in enumerate(zip(points, (*points[1:], points[0])), 1)
        )

        layout = calculate_ceiling_layout(walls)
        boundary = [Vec2(point) for point in layout.boundary]

        self.assertTrue(layout.panels)
        self.assertTrue(
            all(
                is_point_in_polygon_2d(Vec2(vertex), boundary) >= 0
                for panel in layout.panels
                for vertex in panel.vertices
            )
        )


if __name__ == "__main__":
    unittest.main()
