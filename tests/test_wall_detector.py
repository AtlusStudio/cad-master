import unittest

import ezdxf
from ezdxf.document import Drawing

from src.wall_detector import _valid_unicode, detect_walls


def wall_doc(color: int = 1) -> Drawing:
    doc = ezdxf.new()
    doc.layers.add("WALL", color=color)
    return doc


class WallDetectorTest(unittest.TestCase):
    def test_invalid_unicode_surrogate_is_replaced(self) -> None:
        self.assertEqual(_valid_unicode("墙\udc90"), "墙\ufffd")
        self.assertEqual(_valid_unicode("å»ºç­‘"), "建筑")

    def test_parallel_lines_become_one_center_wall(self) -> None:
        doc = wall_doc()
        modelspace = doc.modelspace()
        modelspace.add_line((0, 0), (3000, 0), dxfattribs={"layer": "WALL"})
        modelspace.add_line((0, 100), (3000, 100), dxfattribs={"layer": "WALL"})

        result = detect_walls(doc)

        self.assertEqual(len(result.walls), 1)
        self.assertAlmostEqual(result.walls[0].start[1], 50)
        self.assertAlmostEqual(result.walls[0].length, 3000)

    def test_staggered_faces_extend_a_seeded_wall_band(self) -> None:
        doc = wall_doc()
        modelspace = doc.modelspace()
        modelspace.add_line((0, 0), (400, 0), dxfattribs={"layer": "WALL"})
        modelspace.add_line((800, 0), (1200, 0), dxfattribs={"layer": "WALL"})
        modelspace.add_line((0, 50), (1000, 50), dxfattribs={"layer": "WALL"})

        result = detect_walls(doc)

        self.assertEqual(len(result.walls), 1)
        self.assertAlmostEqual(result.walls[0].length, 1200)
        self.assertAlmostEqual(result.walls[0].start[1], 25)

    def test_unseeded_single_face_is_not_recovered(self) -> None:
        doc = wall_doc()
        doc.modelspace().add_line((0, 0), (3000, 0), dxfattribs={"layer": "WALL"})

        self.assertEqual(detect_walls(doc).walls, ())

    def test_disconnected_single_face_does_not_extend_a_seeded_band(self) -> None:
        doc = wall_doc()
        modelspace = doc.modelspace()
        modelspace.add_line((0, 0), (500, 0), dxfattribs={"layer": "WALL"})
        modelspace.add_line((0, 50), (500, 50), dxfattribs={"layer": "WALL"})
        modelspace.add_line((2000, 0), (3000, 0), dxfattribs={"layer": "WALL"})

        result = detect_walls(doc)

        self.assertEqual(len(result.walls), 1)
        self.assertAlmostEqual(result.walls[0].length, 500)

    def test_layer_name_does_not_need_wall_keyword(self) -> None:
        doc = ezdxf.new()
        doc.layers.add("PARTITION-A", color=1)
        modelspace = doc.modelspace()
        modelspace.add_line((0, 0), (3000, 0), dxfattribs={"layer": "PARTITION-A"})
        modelspace.add_line((0, 50), (3000, 50), dxfattribs={"layer": "PARTITION-A"})

        self.assertEqual(len(detect_walls(doc).walls), 1)

    def test_xref_layer_uses_matching_leaf_layer_color(self) -> None:
        doc = ezdxf.new()
        doc.layers.add("SOURCE$0$WALL-MOVE", color=6)
        modelspace = doc.modelspace()
        modelspace.add_line((0, 0), (3000, 0), dxfattribs={"layer": "BROKEN$0$WALL-MOVE"})
        modelspace.add_line((0, 100), (3000, 100), dxfattribs={"layer": "BROKEN$0$WALL-MOVE"})

        self.assertEqual(len(detect_walls(doc).walls), 1)

    def test_door_gap_is_not_bridged(self) -> None:
        doc = wall_doc()
        modelspace = doc.modelspace()
        for y in (0, 100):
            modelspace.add_line((0, y), (1000, y), dxfattribs={"layer": "WALL"})
            modelspace.add_line((1900, y), (3000, y), dxfattribs={"layer": "WALL"})

        result = detect_walls(doc)

        self.assertEqual(sorted(round(wall.length) for wall in result.walls), [1000, 1100])

    def test_same_color_window_geometry_is_a_fixed_opening(self) -> None:
        doc = wall_doc()
        modelspace = doc.modelspace()
        for y in (0, 100):
            modelspace.add_line((0, y), (900, y), dxfattribs={"layer": "WALL"})
            modelspace.add_line((2100, y), (3000, y), dxfattribs={"layer": "WALL"})
        for y in (0, 30, 70, 100):
            modelspace.add_line((900, y), (2100, y), dxfattribs={"layer": "WALL"})

        result = detect_walls(doc)

        self.assertEqual(len(result.walls), 1)
        self.assertEqual(result.walls[0].openings[0].kind, "window")
        self.assertAlmostEqual(
            result.walls[0].openings[0].end_offset
            - result.walls[0].openings[0].start_offset,
            1200,
        )

    def test_non_wall_layer_window_geometry_only_bridges_the_wall(self) -> None:
        doc = wall_doc()
        doc.layers.add("WINDOW", color=7)
        modelspace = doc.modelspace()
        for y in (0, 100):
            modelspace.add_line((0, y), (900, y), dxfattribs={"layer": "WALL"})
            modelspace.add_line((2100, y), (3000, y), dxfattribs={"layer": "WALL"})
        for y in (0, 30, 70, 100):
            modelspace.add_line((900, y), (2100, y), dxfattribs={"layer": "WINDOW"})

        result = detect_walls(doc)

        self.assertEqual(len(result.walls), 1)
        self.assertEqual(result.walls[0].source_layer, "WALL")
        self.assertEqual(result.walls[0].openings[0].kind, "window")

    def test_same_color_door_arc_and_leaf_lines_are_not_walls(self) -> None:
        doc = wall_doc()
        modelspace = doc.modelspace()
        for y in (0, 50):
            modelspace.add_line((0, y), (1000, y), dxfattribs={"layer": "WALL"})
            modelspace.add_line((2000, y), (3000, y), dxfattribs={"layer": "WALL"})
        modelspace.add_arc(
            (1975, 25),
            975,
            180,
            270,
            dxfattribs={"layer": "WALL"},
        )
        for x in (1950, 2000):
            modelspace.add_line((x, 25), (x, -950), dxfattribs={"layer": "WALL"})

        result = detect_walls(doc)

        self.assertEqual(len(result.walls), 1)
        self.assertEqual(result.walls[0].openings[0].kind, "door")
        self.assertAlmostEqual(
            result.walls[0].openings[0].end_offset
            - result.walls[0].openings[0].start_offset,
            1000,
        )

    def test_mirrored_open_door_leaf_is_not_a_wall(self) -> None:
        doc = wall_doc()
        door = doc.blocks.new("SWING")
        door.add_arc((1000, 0), 975, 0, 90)
        door.add_line((1000, 0), (1000, 975))
        door.add_line((1050, 0), (1050, 975))
        doc.modelspace().add_blockref(
            "SWING",
            (0, 0),
            dxfattribs={"layer": "WALL", "xscale": -1},
        )

        self.assertEqual(detect_walls(doc).walls, ())

    def test_t_junction_keeps_the_through_wall_continuous(self) -> None:
        doc = wall_doc()
        modelspace = doc.modelspace()
        for y in (0, 100):
            modelspace.add_line((0, y), (3000, y), dxfattribs={"layer": "WALL"})
        for x in (1450, 1550):
            modelspace.add_line((x, 100), (x, 2000), dxfattribs={"layer": "WALL"})

        result = detect_walls(doc)

        self.assertEqual(len(result.walls), 2)
        self.assertEqual(sorted(round(wall.length) for wall in result.walls), [1895, 3000])

    def test_door_block_is_not_a_wall(self) -> None:
        doc = ezdxf.new()
        doc.layers.add("WALL")
        door = doc.blocks.new("DOOR-900")
        door.add_line((0, 0), (1000, 0), dxfattribs={"layer": "WALL"})
        door.add_line((0, 100), (1000, 100), dxfattribs={"layer": "WALL"})
        doc.modelspace().add_blockref("DOOR-900", (0, 0), dxfattribs={"layer": "WALL"})

        self.assertEqual(detect_walls(doc).walls, ())

    def test_non_wall_leaf_layer_is_not_a_wall(self) -> None:
        doc = ezdxf.new()
        layer = "BUILDING$0$02-WALL$0$STAIR"
        doc.layers.add(layer)
        modelspace = doc.modelspace()
        modelspace.add_line((0, 0), (3000, 0), dxfattribs={"layer": layer})
        modelspace.add_line((0, 100), (3000, 100), dxfattribs={"layer": layer})

        self.assertEqual(detect_walls(doc).walls, ())

    def test_short_parallel_door_frame_lines_are_ignored(self) -> None:
        doc = wall_doc()
        modelspace = doc.modelspace()
        modelspace.add_line((0, 0), (100, 0), dxfattribs={"layer": "WALL"})
        modelspace.add_line((0, 100), (100, 100), dxfattribs={"layer": "WALL"})

        self.assertEqual(detect_walls(doc).walls, ())

    def test_non_target_gray_wall_is_ignored(self) -> None:
        doc = wall_doc()
        modelspace = doc.modelspace()
        modelspace.add_line((0, 0), (3000, 0), dxfattribs={"layer": "WALL", "color": 8})
        modelspace.add_line((0, 100), (3000, 100), dxfattribs={"layer": "WALL", "color": 8})

        self.assertEqual(detect_walls(doc).walls, ())

    def test_non_target_by_layer_gray_wall_is_ignored(self) -> None:
        doc = wall_doc(8)
        modelspace = doc.modelspace()
        modelspace.add_line((0, 0), (3000, 0), dxfattribs={"layer": "WALL"})
        modelspace.add_line((0, 100), (3000, 100), dxfattribs={"layer": "WALL"})

        self.assertEqual(detect_walls(doc).walls, ())

    def test_purple_wall_is_recognized(self) -> None:
        doc = wall_doc(6)
        modelspace = doc.modelspace()
        modelspace.add_line((0, 0), (3000, 0), dxfattribs={"layer": "WALL"})
        modelspace.add_line((0, 75), (3000, 75), dxfattribs={"layer": "WALL"})

        self.assertEqual(len(detect_walls(doc).walls), 1)

    def test_unlisted_wall_thickness_is_ignored(self) -> None:
        doc = wall_doc()
        modelspace = doc.modelspace()
        modelspace.add_line((0, 0), (3000, 0), dxfattribs={"layer": "WALL"})
        modelspace.add_line((0, 80), (3000, 80), dxfattribs={"layer": "WALL"})

        self.assertEqual(detect_walls(doc).walls, ())


if __name__ == "__main__":
    unittest.main()
