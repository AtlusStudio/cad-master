from __future__ import annotations

import argparse
import json
import os
from dataclasses import asdict
from pathlib import Path

from .ai_recognizer import (
    apply_recognition_decisions,
    build_detected_model,
    build_recognition_input,
    request_recognition,
)
from .ceiling_layout import calculate_ceiling_layout, draw_ceiling_layout
from .config import DEFAULT_CONFIG, MaterialConfig
from .dxf_reader import (
    ensure_panel_layers,
    read_dxf,
    save_detected_walls,
    save_dxf,
    save_review_walls,
)
from .material_report import write_schedule
from .panel_drawer import collect_obstacle_boxes, draw_wall_layout
from .panel_optimizer import layout_wall
from .wall_detector import DetectionResult, OpeningSpan, WallSegment, detect_walls

AI_ENV_NAMES = ("CAD_AI_BASE_URL", "CAD_AI_API_KEY", "CAD_AI_MODEL")


def load_env() -> None:
    path = Path(__file__).resolve().parent.parent / ".env"
    if not path.is_file():
        return
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        name, separator, value = line.partition("=")
        name = name.strip()
        if separator and name in AI_ENV_NAMES and name not in os.environ:
            os.environ[name] = value.strip().strip('"').strip("'")


def load_materials(path: str | Path) -> MaterialConfig:
    source = Path(path)
    if not source.is_file():
        raise FileNotFoundError(f"找不到材料配置: {source}")
    data = json.loads(source.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError("materials.json 顶层必须是对象")
    widths = tuple(float(value) for value in data.get("standard_widths", ()))
    joint_gap = float(data.get("joint_gap", 3.0))
    primary_width = float(data.get("primary_width", 1180.0))
    min_cut_width = float(data.get("min_cut_width", 150.0))
    cut_step = float(data.get("cut_step", 5.0))
    end_tolerance = float(data.get("end_tolerance", 2.5))
    if not widths or any(width <= 0 for width in widths):
        raise ValueError("standard_widths 必须是正数数组")
    if joint_gap < 0:
        raise ValueError("joint_gap 不能为负数")
    if primary_width not in widths:
        raise ValueError("primary_width 必须包含在 standard_widths 中")
    if min_cut_width <= 0 or cut_step <= 0 or end_tolerance < 0:
        raise ValueError("min_cut_width、cut_step 必须为正数，end_tolerance 不能为负数")
    return MaterialConfig(
        widths,
        joint_gap,
        primary_width,
        min_cut_width,
        cut_step,
        end_tolerance,
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="CMS 转换阶段 worker")
    parser.add_argument("--stage", required=True, choices=("detect", "recognize", "generate"))
    parser.add_argument("--mode", required=True, choices=("ai", "local"))
    parser.add_argument("--input", required=True)
    parser.add_argument("--materials", required=True)
    parser.add_argument("--output", required=True)
    return parser.parse_args()


def _detection_from_data(data: dict) -> DetectionResult:
    return DetectionResult(
        walls=tuple(
            WallSegment(
                id=wall["id"],
                start=tuple(wall["start"]),
                end=tuple(wall["end"]),
                thickness=wall["thickness"],
                openings=tuple(
                    OpeningSpan(
                        start_offset=opening["start_offset"],
                        end_offset=opening["end_offset"],
                        kind=opening["kind"],
                        id=opening["id"],
                        confidence=opening["confidence"],
                        evidence=tuple(opening["evidence"]),
                        source_hint=opening["source_hint"],
                    )
                    for opening in wall["openings"]
                ),
                source_layer=wall["source_layer"],
                confidence=wall["confidence"],
                evidence=tuple(wall["evidence"]),
                wall_type=wall["wall_type"],
            )
            for wall in data["walls"]
        ),
        thickness_counts=tuple(tuple(item) for item in data["thickness_counts"]),
        skipped_curves=data["skipped_curves"],
        face_count=data["face_count"],
    )


def _checkpoint_path(output_path: str) -> Path:
    return Path(output_path).parent / "conversion_checkpoint.json"


def _read_checkpoint(output_path: str) -> dict:
    path = _checkpoint_path(output_path)
    if not path.is_file():
        raise ValueError("缺少候选提取阶段的 checkpoint")
    return json.loads(path.read_text(encoding="utf-8"))


def _write_checkpoint(output_path: str, data: dict) -> None:
    path = _checkpoint_path(output_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")


def _write_review(
    output_path: str,
    doc,
    candidates: DetectionResult,
    accepted: DetectionResult,
) -> None:
    directory = Path(output_path).parent
    handles = save_review_walls(
        doc,
        candidates.walls,
        accepted.walls,
        directory / "review_candidates.dxf",
    )
    (directory / "review_entities.json").write_text(
        json.dumps(handles, ensure_ascii=False),
        encoding="utf-8",
    )


def detect_stage(args: argparse.Namespace) -> None:
    doc = read_dxf(args.input)
    drawing_path = (
        Path(args.input).with_suffix(".dxf")
        if Path(args.input).suffix.lower() == ".dwg"
        else Path(args.input)
    )
    candidates = detect_walls(
        doc,
        DEFAULT_CONFIG,
        include_all_colors=args.mode == "ai",
    )
    if not candidates.walls:
        message = (
            "未识别到颜色和墙厚符合配置的双线墙"
            if args.mode == "local"
            else "未提取到墙厚符合配置的双线墙候选"
        )
        raise ValueError(message)
    _write_checkpoint(
        args.output,
        {
            "drawing_path": str(drawing_path),
            "candidates": asdict(candidates),
        },
    )
    if args.mode == "local":
        _write_review(args.output, doc, candidates, candidates)


def recognize_stage(args: argparse.Namespace) -> None:
    load_env()
    checkpoint = _read_checkpoint(args.output)
    candidates = _detection_from_data(checkpoint["candidates"])
    doc = read_dxf(checkpoint["drawing_path"])
    base_url = os.environ.get("CAD_AI_BASE_URL")
    api_key = os.environ.get("CAD_AI_API_KEY")
    model = os.environ.get("CAD_AI_MODEL")
    missing = [
        name
        for name, value in (
            ("CAD_AI_BASE_URL", base_url),
            ("CAD_AI_API_KEY", api_key),
            ("CAD_AI_MODEL", model),
        )
        if not value
    ]
    if missing:
        raise RuntimeError(f"默认 AI 识别缺少环境变量: {', '.join(missing)}")
    recognition_input = build_recognition_input(doc, candidates)
    decisions = request_recognition(recognition_input, base_url, api_key, model)
    output_directory = Path(args.output).parent
    (output_directory / "ai_recognition.json").write_text(
        json.dumps(decisions, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    (output_directory / "detected_model.json").write_text(
        json.dumps(
            build_detected_model(args.input, doc, candidates, decisions, model),
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    detected = apply_recognition_decisions(candidates, decisions)
    checkpoint["detected"] = asdict(detected)
    _write_checkpoint(args.output, checkpoint)
    _write_review(args.output, doc, candidates, detected)


def generate_stage(args: argparse.Namespace) -> None:
    checkpoint = _read_checkpoint(args.output)
    if "detected" not in checkpoint:
        raise ValueError("缺少语义识别阶段的 checkpoint")
    detected = _detection_from_data(checkpoint["detected"])
    materials = load_materials(args.materials)
    output = Path(args.output)
    ceiling_output = output.parent / "ceiling_panel_layout_result.dxf"
    doc = read_dxf(checkpoint["drawing_path"])
    detected_walls_output = output.parent / "detected_walls.dxf"
    save_detected_walls(doc, detected.walls, detected_walls_output)

    obstacles = collect_obstacle_boxes(doc, DEFAULT_CONFIG.wall_colors)
    ensure_panel_layers(doc)
    all_panels = []
    for wall in detected.walls:
        panels = layout_wall(wall, materials)
        draw_wall_layout(doc, wall, panels, obstacles)
        all_panels.extend(panels)

    ceiling_doc = read_dxf(checkpoint["drawing_path"])
    ceiling_layout = calculate_ceiling_layout(
        detected.walls,
        DEFAULT_CONFIG.junction_reserve,
    )
    draw_ceiling_layout(ceiling_doc, ceiling_layout)

    save_dxf(doc, output)
    save_dxf(ceiling_doc, ceiling_output)
    write_schedule(all_panels, output.parent)
    thicknesses = ", ".join(f"{width}mm×{count}" for width, count in detected.thickness_counts)
    print(
        f"已输出: {output}、{ceiling_output}、{detected_walls_output}"
        f"（候选墙面 {detected.face_count}，"
        f"墙段 {len(detected.walls)}，"
        f"墙厚 {thicknesses or '无'}，"
        f"跳过曲线段 {detected.skipped_curves}）"
    )


def main() -> None:
    args = parse_args()
    try:
        {
            "detect": detect_stage,
            "recognize": recognize_stage,
            "generate": generate_stage,
        }[args.stage](args)
    except (FileNotFoundError, RuntimeError, ValueError) as error:
        raise SystemExit(f"\n错误: {error}") from None


if __name__ == "__main__":
    main()
