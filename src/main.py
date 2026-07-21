from __future__ import annotations

import argparse
import json
import os
from dataclasses import replace
from pathlib import Path

from .ai_recognizer import (
    apply_recognition_decisions,
    build_detected_model,
    build_recognition_input,
    request_recognition,
)
from .config import DEFAULT_CONFIG, MaterialConfig
from .dxf_reader import ensure_panel_layers, read_dxf, save_detected_walls, save_dxf
from .material_report import write_schedule
from .panel_drawer import collect_obstacle_boxes, draw_wall_layout
from .panel_optimizer import layout_wall
from .wall_detector import detect_walls

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
    parser = argparse.ArgumentParser(description="洁净室彩钢板墙体自动排版")
    parser.add_argument(
        "--input",
        default="input/source.dwg",
        help="源 DXF 或 DWG 文件，默认 input/source.dwg",
    )
    parser.add_argument("--materials", default="input/materials.json", help="材料配置 JSON")
    parser.add_argument(
        "--output",
        default="output/panel_layout_result.dxf",
        help="输出 DXF 文件，默认 output/panel_layout_result.dxf",
    )
    parser.add_argument(
        "--wall-color",
        action="append",
        type=int,
        help="允许识别的 ACI 墙线颜色号，可重复传入；默认红色 1、紫色 6",
    )
    parser.add_argument(
        "--wall-thickness",
        action="append",
        type=float,
        help="优先识别的墙厚，可重复传入；默认 50、75、100mm",
    )
    parser.add_argument(
        "--wall-thickness-tolerance",
        type=float,
        default=DEFAULT_CONFIG.wall_thickness_tolerance,
        help="墙厚允许误差，默认 ±10mm",
    )
    parser.add_argument(
        "--junction-reserve",
        type=float,
        default=DEFAULT_CONFIG.junction_reserve,
        help="T 型墙连接端预留量，默认 5mm",
    )
    parser.add_argument(
        "--local-recognition",
        action="store_true",
        help="使用原有纯本地识别；默认调用 AI 识别",
    )
    return parser.parse_args()


def run(
    input_path: str,
    materials_path: str,
    output_path: str,
    wall_colors: tuple[int, ...] | None = None,
    wall_thicknesses: tuple[float, ...] | None = None,
    junction_reserve: float = DEFAULT_CONFIG.junction_reserve,
    local_recognition: bool = False,
    wall_thickness_tolerance: float = DEFAULT_CONFIG.wall_thickness_tolerance,
) -> None:
    load_env()
    if Path(input_path).resolve() == Path(output_path).resolve():
        raise ValueError("输出 DXF 不能覆盖原始文件")

    materials = load_materials(materials_path)
    colors = wall_colors or DEFAULT_CONFIG.wall_colors
    thicknesses = wall_thicknesses or DEFAULT_CONFIG.wall_thicknesses
    if any(not 1 <= color <= 255 for color in colors):
        raise ValueError("墙线 ACI 颜色号必须在 1–255 之间")
    if any(thickness <= 0 for thickness in thicknesses):
        raise ValueError("墙厚必须大于 0")
    if wall_thickness_tolerance < 0:
        raise ValueError("墙厚允许误差不能为负数")
    if not 0 <= junction_reserve <= 10:
        raise ValueError("T 型墙连接端预留量必须在 0–10mm 之间")
    drawing_config = replace(
        DEFAULT_CONFIG,
        wall_colors=colors,
        wall_thicknesses=thicknesses,
        wall_thickness_tolerance=wall_thickness_tolerance,
        junction_reserve=junction_reserve,
    )
    total_steps = 4 if local_recognition else 6
    print(f"[1/{total_steps}] 读取 CAD 图纸...", flush=True)
    doc = read_dxf(input_path)
    output = Path(output_path)
    print(f"[2/{total_steps}] 提取墙体候选...", flush=True)
    candidates = detect_walls(doc, drawing_config, include_all_colors=not local_recognition)
    if not candidates.walls:
        message = (
            "未识别到颜色和墙厚符合配置的双线墙"
            if local_recognition
            else "未提取到墙厚符合配置的双线墙候选"
        )
        raise ValueError(message)

    detected = candidates
    if not local_recognition:
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
            raise RuntimeError(
                f"默认 AI 识别缺少环境变量: {', '.join(missing)}；"
                "如需使用原有规则，请传入 --local-recognition"
            )
        recognition_input = build_recognition_input(doc, candidates)
        print(
            f"[3/6] 请求 AI 识别（{model}，墙段 {len(recognition_input['walls'])}，"
            f"洞口 {len(recognition_input['openings'])}）...",
            flush=True,
        )
        decisions = request_recognition(recognition_input, base_url, api_key, model)
        print("[4/6] 校验并保存 AI 识别结果...", flush=True)
        output.parent.mkdir(parents=True, exist_ok=True)
        (output.parent / "ai_recognition.json").write_text(
            json.dumps(decisions, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        (output.parent / "detected_model.json").write_text(
            json.dumps(
                build_detected_model(input_path, doc, candidates, decisions, model),
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )
        detected = apply_recognition_decisions(candidates, decisions)
        if not detected.walls:
            raise ValueError("AI 未确认任何需要安装彩钢板的墙段")

    detected_walls_output = output.parent / "detected_walls.dxf"
    save_detected_walls(doc, detected.walls, detected_walls_output)

    draw_step = 3 if local_recognition else 5
    print(f"[{draw_step}/{total_steps}] 计算并绘制墙板排版...", flush=True)
    obstacles = collect_obstacle_boxes(doc, colors)
    ensure_panel_layers(doc)
    all_panels = []
    for wall in detected.walls:
        panels = layout_wall(wall, materials)
        draw_wall_layout(doc, wall, panels, obstacles)
        all_panels.extend(panels)

    print(f"[{draw_step + 1}/{total_steps}] 写入 DXF 和材料清单...", flush=True)
    save_dxf(doc, output)
    write_schedule(all_panels, output.parent)
    thicknesses = ", ".join(f"{width}mm×{count}" for width, count in detected.thickness_counts)
    print(
        f"已输出: {output}、{detected_walls_output}（候选墙面 {detected.face_count}，"
        f"墙段 {len(detected.walls)}，"
        f"墙厚 {thicknesses or '无'}，"
        f"跳过曲线段 {detected.skipped_curves}）"
    )


def main() -> None:
    args = parse_args()
    try:
        run(
            args.input,
            args.materials,
            args.output,
            tuple(args.wall_color) if args.wall_color else None,
            tuple(args.wall_thickness) if args.wall_thickness else None,
            args.junction_reserve,
            args.local_recognition,
            args.wall_thickness_tolerance,
        )
    except (FileNotFoundError, RuntimeError, ValueError) as error:
        raise SystemExit(f"\n错误: {error}") from None


if __name__ == "__main__":
    main()
