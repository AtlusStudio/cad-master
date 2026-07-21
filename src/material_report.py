from __future__ import annotations

import csv
import json
from collections import defaultdict
from pathlib import Path

from .panel_optimizer import Panel


def build_schedule(panels: list[Panel]) -> list[dict[str, object]]:
    walls: dict[str, list[Panel]] = defaultdict(list)
    groups: dict[tuple[str, float, bool], list[Panel]] = defaultdict(list)
    for panel in panels:
        walls[panel.wall_id].append(panel)
        groups[(panel.wall_id, round(panel.width, 3), panel.is_cut)].append(panel)

    wall_metrics: dict[str, tuple[float, int, int]] = {}
    for wall_id, wall_panels in walls.items():
        total = sum(panel.width for panel in wall_panels)
        standard = sum(panel.width for panel in wall_panels if not panel.is_cut)
        cuts = [panel for panel in wall_panels if panel.is_cut]
        wall_metrics[wall_id] = (
            round(standard / total * 100, 2),
            len(cuts),
            len({round(panel.width, 3) for panel in cuts}),
        )

    return [
        {
            "wall_id": wall_id,
            "panel_type": "CUT" if is_cut else "STANDARD",
            "width_mm": width,
            "quantity": len(group),
            "total_width_mm": round(width * len(group), 3),
            "fit_adjustment_mm": round(sum(panel.fit_adjustment for panel in group), 3),
            "standard_ratio_pct": wall_metrics[wall_id][0],
            "cut_quantity": wall_metrics[wall_id][1],
            "cut_type_count": wall_metrics[wall_id][2],
        }
        for (wall_id, width, is_cut), group in sorted(groups.items())
    ]


def write_schedule(panels: list[Panel], output_dir: str | Path) -> None:
    directory = Path(output_dir)
    directory.mkdir(parents=True, exist_ok=True)
    rows = build_schedule(panels)
    fields = [
        "wall_id",
        "panel_type",
        "width_mm",
        "quantity",
        "total_width_mm",
        "fit_adjustment_mm",
        "standard_ratio_pct",
        "cut_quantity",
        "cut_type_count",
    ]
    with (directory / "panel_schedule.csv").open("w", encoding="utf-8-sig", newline="") as file:
        writer = csv.DictWriter(file, fieldnames=fields)
        writer.writeheader()
        writer.writerows(rows)
    (directory / "panel_schedule.json").write_text(
        json.dumps(rows, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
