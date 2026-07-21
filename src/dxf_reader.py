from __future__ import annotations

import codecs
import shutil
import subprocess
from collections.abc import Iterable
from pathlib import Path

import ezdxf
from ezdxf import recover
from ezdxf.document import Drawing
from ezdxf.lldxf.const import DXFStructureError

from .config import LAYERS
from .geometry import left_normal, point_at, translated
from .wall_detector import WallSegment


def _detect_utf8(path: Path) -> str | None:
    decoder = codecs.getincrementaldecoder("utf-8")()
    has_non_ascii = False
    try:
        with path.open("rb") as source:
            for chunk in iter(lambda: source.read(1024 * 1024), b""):
                has_non_ascii = has_non_ascii or any(byte >= 128 for byte in chunk)
                decoder.decode(chunk)
        decoder.decode(b"", final=True)
    except UnicodeDecodeError:
        return None
    return "utf-8" if has_non_ascii else None


def read_dxf(path: str | Path) -> Drawing:
    source = Path(path)
    if not source.is_file():
        raise FileNotFoundError(f"找不到 CAD 文件: {source}")
    suffix = source.suffix.lower()
    if suffix == ".dxf":
        detected_encoding = _detect_utf8(source)
        try:
            doc = ezdxf.readfile(source, encoding=detected_encoding)
        except DXFStructureError:
            doc, _ = recover.readfile(source)
        if detected_encoding == "utf-8" and doc.dxfversion < "AC1021":
            doc.encoding = "gbk"
        for insert in doc.query("INSERT"):
            if insert.dxf.name not in doc.blocks:
                insert.destroy()
        return doc
    if suffix == ".dwg":
        converter = shutil.which("dwg2dxf")
        if converter is None:
            raise RuntimeError("读取 DWG 需要先安装 GNU LibreDWG: brew install libredwg")
        converted = source.with_suffix(".dxf")
        subprocess.run(
            [converter, "--as", "r2013", "--overwrite", "-o", converted, source],
            check=True,
        )
        return read_dxf(converted)
    raise ValueError(f"仅支持 DXF 或 DWG 文件: {source}")


def ensure_panel_layers(doc: Drawing) -> None:
    for name, color in LAYERS.items():
        if name not in doc.layers:
            doc.layers.add(name, color=color)


def save_dxf(doc: Drawing, path: str | Path) -> None:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    doc.saveas(target)


def save_detected_walls(
    source_doc: Drawing,
    walls: Iterable[WallSegment],
    path: str | Path,
) -> None:
    wall_doc = ezdxf.new(source_doc.dxfversion)
    wall_doc.header["$INSUNITS"] = source_doc.header.get("$INSUNITS", 0)
    wall_doc.layers.add("CALCULATED_SURFACE", color=3)
    wall_doc.layers.add("CALCULATED_DOOR", color=2)
    wall_doc.layers.add("CALCULATED_WINDOW", color=4)
    wall_doc.layers.add("CALCULATED_LOW_CONFIDENCE", color=30)
    modelspace = wall_doc.modelspace()
    for wall in walls:
        normal = left_normal(wall.start, wall.end)
        half_thickness = wall.thickness / 2.0
        wall_layer = (
            "CALCULATED_LOW_CONFIDENCE"
            if wall.confidence < 0.85
            else "CALCULATED_SURFACE"
        )
        for offset in (-half_thickness, half_thickness):
            modelspace.add_line(
                translated(wall.start, normal, offset),
                translated(wall.end, normal, offset),
                dxfattribs={"layer": wall_layer},
            )
        for opening in wall.openings:
            layer = (
                "CALCULATED_LOW_CONFIDENCE"
                if opening.confidence < 0.85
                else f"CALCULATED_{opening.kind.upper()}"
            )
            start = point_at(wall.start, wall.end, opening.start_offset, wall.length)
            end = point_at(wall.start, wall.end, opening.end_offset, wall.length)
            corners = (
                translated(start, normal, -half_thickness),
                translated(start, normal, half_thickness),
                translated(end, normal, half_thickness),
                translated(end, normal, -half_thickness),
            )
            for first, second in zip(corners, (*corners[1:], corners[0])):
                modelspace.add_line(first, second, dxfattribs={"layer": layer})
    save_dxf(wall_doc, path)
