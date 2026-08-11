from __future__ import annotations

from collections.abc import Iterable

from ezdxf import bbox
from ezdxf.document import Drawing
from ezdxf.enums import MTextEntityAlignment

from .config import DEFAULT_CONFIG, DrawingConfig
from .geometry import angle_degrees, left_normal, point_at, translated
from .panel_optimizer import Panel
from .wall_detector import WallSegment, _effective_color

Box = tuple[float, float, float, float]


def collect_obstacle_boxes(
    doc: Drawing,
    wall_colors: tuple[int, ...] = DEFAULT_CONFIG.wall_colors,
) -> list[Box]:
    boxes: list[Box] = []
    for entity in doc.modelspace():
        layer = str(entity.dxf.get("layer", "0"))
        color = _effective_color(doc, entity, layer)
        if layer.startswith("PANEL_") or color in wall_colors:
            continue
        if entity.dxftype() == "HATCH":
            continue
        try:
            extents = bbox.extents([entity], fast=True)
        except (TypeError, ValueError):
            continue
        if extents.has_data:
            boxes.append((extents.extmin.x, extents.extmin.y, extents.extmax.x, extents.extmax.y))
    return boxes


def _overlaps(first: Box, second: Box) -> bool:
    return not (
        first[2] < second[0]
        or second[2] < first[0]
        or first[3] < second[1]
        or second[3] < first[1]
    )


def _label_box(
    center: tuple[float, float],
    unit: tuple[float, float],
    normal: tuple[float, float],
    label: str,
    config: DrawingConfig,
) -> Box:
    half_width = len(label) * config.text_height * 0.325
    half_height = config.text_height / 2.0
    extent_x = abs(unit[0]) * half_width + abs(normal[0]) * half_height
    extent_y = abs(unit[1]) * half_width + abs(normal[1]) * half_height
    return center[0] - extent_x, center[1] - extent_y, center[0] + extent_x, center[1] + extent_y


def _label_side(
    wall: WallSegment,
    panels: list[Panel],
    obstacles: list[Box],
    config: DrawingConfig,
) -> float:
    length = wall.length
    unit = (wall.end[0] - wall.start[0]) / length, (wall.end[1] - wall.start[1]) / length
    normal = -unit[1], unit[0]
    scores: dict[float, int] = {}
    for side in (1.0, -1.0):
        score = 0
        for panel in panels:
            midpoint = point_at(wall.start, wall.end, (panel.start_offset + panel.end_offset) / 2.0, length)
            center = translated(midpoint, normal, side * config.text_offset)
            label = str(round(panel.width))
            candidate = _label_box(center, unit, normal, label, config)
            score += sum(_overlaps(candidate, obstacle) for obstacle in obstacles)
        scores[side] = score
    return -1.0 if scores[-1.0] < scores[1.0] else 1.0


def draw_wall_layout(
    doc: Drawing,
    wall: WallSegment,
    panels: Iterable[Panel],
    obstacles: list[Box],
    config: DrawingConfig = DEFAULT_CONFIG,
) -> None:
    modelspace = doc.modelspace()
    panel_list = list(panels)
    normal = left_normal(wall.start, wall.end)
    side = _label_side(wall, panel_list, obstacles, config)
    delta_x = wall.end[0] - wall.start[0]
    rotation = (
        90.0
        if abs(delta_x) <= config.tolerance
        else angle_degrees(wall.start, wall.end) % 360.0
    )
    if 90.0 < rotation <= 270.0:
        rotation = (rotation + 180.0) % 360.0

    for panel in panel_list:
        midpoint = point_at(
            wall.start,
            wall.end,
            (panel.start_offset + panel.end_offset) / 2.0,
            wall.length,
        )
        label_at = translated(midpoint, normal, side * config.text_offset)
        modelspace.add_mtext(
            str(round(panel.width)),
            dxfattribs={
                "layer": "PANEL_TEXT",
                "char_height": config.text_height,
            },
        ).set_location(
            label_at,
            rotation=rotation,
            attachment_point=MTextEntityAlignment.MIDDLE_CENTER,
        )

    half_joint = wall.thickness / 2.0
    for panel, next_panel in zip(panel_list, panel_list[1:]):
        if any(
            panel.end_offset <= opening.start_offset
            and opening.end_offset <= next_panel.start_offset
            for opening in wall.openings
        ):
            continue
        center = point_at(
            wall.start,
            wall.end,
            next_panel.start_offset,
            wall.length,
        )
        modelspace.add_line(
            translated(center, normal, -half_joint),
            translated(center, normal, half_joint),
            dxfattribs={"layer": "PANEL_JOINT"},
        )
