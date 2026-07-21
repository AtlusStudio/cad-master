import tempfile
import unittest
from pathlib import Path

import ezdxf

from src.dxf_reader import _detect_utf8, read_dxf, save_detected_walls
from src.wall_detector import OpeningSpan, WallSegment


class DxfReaderTest(unittest.TestCase):
    def test_detects_utf8_chinese_in_legacy_dxf(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "source.dxf"
            path.write_bytes("0\nSECTION\n2\n图层：墙\n".encode("utf-8"))
            self.assertEqual(_detect_utf8(path), "utf-8")

    def test_does_not_label_gbk_as_utf8(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "source.dxf"
            path.write_bytes("图层：墙".encode("gbk"))
            self.assertIsNone(_detect_utf8(path))

    def test_reads_legacy_utf8_and_exports_as_chinese_codepage(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "source.dxf"
            doc = ezdxf.new("R14")
            doc.modelspace().add_text("中文墙体")
            doc.saveas(path, encoding="utf-8")

            loaded = read_dxf(path)

            self.assertEqual(loaded.modelspace().query("TEXT").first.dxf.text, "中文墙体")
            self.assertEqual(loaded.encoding, "gbk")

    def test_detected_walls_shows_every_calculated_surface(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "detected_walls.dxf"
            source = ezdxf.new()
            wall = WallSegment(
                "W0001",
                (0, 0),
                (4000, 0),
                50,
                (OpeningSpan(500, 1500, "door"), OpeningSpan(2000, 3200, "window")),
            )

            save_detected_walls(source, (wall,), path)
            result = ezdxf.readfile(path).modelspace()

            self.assertEqual(len(result.query('*[layer=="CALCULATED_SURFACE"]')), 2)
            self.assertEqual(len(result.query('*[layer=="CALCULATED_DOOR"]')), 4)
            self.assertEqual(len(result.query('*[layer=="CALCULATED_WINDOW"]')), 4)


if __name__ == "__main__":
    unittest.main()
