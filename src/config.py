from __future__ import annotations

from dataclasses import dataclass


STANDARD_WIDTHS = (580.0, 1180.0)
PRIMARY_WIDTH = 1180.0
LAYERS = {
    "PANEL_TEXT": 4,
    "PANEL_JOINT": 51,
}


@dataclass(frozen=True)
class DrawingConfig:
    snap_tolerance: float = 1.0
    angle_tolerance: float = 0.1
    parallel_overlap_ratio: float = 0.9
    wall_colors: tuple[int, ...] = (1, 6)
    wall_thicknesses: tuple[float, ...] = (50.0, 75.0, 100.0)
    wall_thickness_tolerance: float = 10.0
    min_wall_length: float = 300.0
    opening_min_width: float = 300.0
    opening_max_width: float = 3000.0
    opening_jamb_tolerance: float = 300.0
    opening_alignment_tolerance: float = 150.0
    text_height: float = 125.0
    text_offset: float = 150.0
    junction_reserve: float = 5.0
    tolerance: float = 1.0


@dataclass(frozen=True)
class MaterialConfig:
    standard_widths: tuple[float, ...] = STANDARD_WIDTHS
    joint_gap: float = 3.0
    primary_width: float = PRIMARY_WIDTH
    min_cut_width: float = 150.0
    cut_step: float = 5.0
    end_tolerance: float = 2.5


@dataclass(frozen=True)
class CeilingConfig:
    panel_width: float = 1180.0
    max_length: float = 3000.0
    joint_gap: float = 3.0
    min_cut_width: float = 150.0
    text_height: float = 125.0


DEFAULT_CONFIG = DrawingConfig()
DEFAULT_CEILING_CONFIG = CeilingConfig()
