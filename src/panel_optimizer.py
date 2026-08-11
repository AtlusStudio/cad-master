from __future__ import annotations

from dataclasses import dataclass
from math import ceil, floor

from .config import DEFAULT_CONFIG, MaterialConfig, PRIMARY_WIDTH, STANDARD_WIDTHS
from .wall_detector import WallSegment


@dataclass(frozen=True)
class PanelSize:
    width: float
    standard_width: float | None


@dataclass(frozen=True)
class Panel:
    wall_id: str
    start_offset: float
    end_offset: float
    width: float
    standard_width: float | None
    fit_adjustment: float = 0.0
    opening_kind: str | None = None

    @property
    def is_cut(self) -> bool:
        return self.standard_width is None


def _ordered(sequence: tuple[float, ...], choices: tuple[float, ...]) -> tuple[float, ...]:
    order = {width: index for index, width in enumerate(choices)}
    return tuple(sorted(sequence, key=order.__getitem__))


def _sequence_key(sequence: tuple[float, ...], choices: tuple[float, ...]) -> tuple[object, ...]:
    primary = choices[0]
    order = {width: index for index, width in enumerate(choices)}
    return -sequence.count(primary), len(sequence), tuple(order[width] for width in sequence)


def _prefer_sequence(
    candidate: tuple[float, ...],
    current: tuple[float, ...] | None,
    choices: tuple[float, ...],
) -> bool:
    return current is None or _sequence_key(candidate, choices) < _sequence_key(current, choices)


def _round_to_step(value: float, step: float) -> float:
    return floor(value / step + 0.5) * step


def optimize_span(
    length: float,
    widths: tuple[float, ...] = STANDARD_WIDTHS,
    joint_gap: float = 3.0,
    primary_width: float = PRIMARY_WIDTH,
    min_cut_width: float = 150.0,
    cut_step: float = 5.0,
    end_tolerance: float = 2.5,
    tolerance: float = DEFAULT_CONFIG.tolerance,
) -> list[PanelSize]:
    """Prefer an all-standard layout, otherwise use valid rounded end cuts."""
    if length <= 0:
        raise ValueError("墙段长度必须大于 0")
    unique_widths = set(widths)
    choices = (primary_width, *sorted(unique_widths - {primary_width}, reverse=True))
    if (
        not choices
        or any(width <= 0 for width in choices)
        or joint_gap < 0
        or min_cut_width <= 0
        or cut_step <= 0
        or end_tolerance < 0
    ):
        raise ValueError("板宽、非标板下限和归整模数必须为正数，拼缝和尾差不能为负数")
    if primary_width not in unique_widths:
        raise ValueError("主板宽必须包含在标准板宽中")

    if length < min_cut_width + joint_gap * 2:
        cut = _round_to_step(length, cut_step)
        if min_cut_width <= cut <= max(choices) and abs(length - cut) <= end_tolerance:
            return [PanelSize(cut, None)]

    limit = ceil(length + joint_gap + tolerance)
    states: list[tuple[float, ...] | None] = [None] * (limit + 1)
    states[0] = ()
    for amount, sequence in enumerate(states):
        if sequence is None:
            continue
        for width in choices:
            next_amount = amount + round(width)
            if next_amount > limit:
                continue
            candidate = _ordered((*sequence, width), choices)
            if _prefer_sequence(candidate, states[next_amount], choices):
                states[next_amount] = candidate

    exact: list[tuple[float, tuple[float, ...]]] = []
    for sequence in states:
        if not sequence:
            continue
        occupied = sum(sequence) + joint_gap * (len(sequence) - 1)
        error = abs(length - occupied)
        if error <= tolerance:
            exact.append((error, sequence))
    if exact:
        sequence = min(exact, key=lambda item: (item[0], *_sequence_key(item[1], choices)))[1]
        return [PanelSize(width, width) for width in sequence]

    usable_length = length - joint_gap * 2
    aligned_standard = [
        (abs(usable_length - sum(sequence)), sequence)
        for sequence in states
        if sequence and abs(usable_length - sum(sequence)) <= end_tolerance
    ]
    if aligned_standard:
        sequence = min(
            aligned_standard,
            key=lambda item: (item[0], *_sequence_key(item[1], choices)),
        )[1]
        return [PanelSize(width, width) for width in sequence]

    candidates: list[tuple[tuple[object, ...], list[PanelSize]]] = []
    for sequence in states:
        if sequence is None:
            continue
        standard_total = sum(sequence)
        order_key = _sequence_key(sequence, choices)[2:]

        one_cut_raw = usable_length - standard_total
        one_cut = _round_to_step(one_cut_raw, cut_step)
        one_cut_error = usable_length - standard_total - one_cut
        if (
            min_cut_width <= one_cut <= max(choices)
            and abs(one_cut_error) <= end_tolerance
        ):
            sizes = [*(PanelSize(width, width) for width in sequence), PanelSize(one_cut, None)]
            key = (
                1,
                -standard_total,
                -sequence.count(primary_width),
                len(sizes),
                *order_key,
            )
            candidates.append((key, sizes))

        two_cut_raw = (usable_length - standard_total) / 2.0
        two_cut = _round_to_step(two_cut_raw, cut_step)
        two_cut_error = usable_length - standard_total - two_cut * 2
        if (
            min_cut_width <= two_cut <= max(choices)
            and abs(two_cut_error) <= end_tolerance
        ):
            sizes = [
                PanelSize(two_cut, None),
                *(PanelSize(width, width) for width in sequence),
                PanelSize(two_cut, None),
            ]
            key = (
                2,
                -standard_total,
                -sequence.count(primary_width),
                len(sizes),
                *order_key,
            )
            candidates.append((key, sizes))

    if not candidates:
        raise ValueError(
            f"墙段 {length:g}mm 无法满足最小非标板 {min_cut_width:g}mm、"
            f"{cut_step:g}mm 归整和 ±{end_tolerance:g}mm 尾差"
        )
    return min(candidates, key=lambda item: item[0])[1]


def layout_wall(
    wall: WallSegment,
    materials: MaterialConfig,
    tolerance: float = DEFAULT_CONFIG.tolerance,
) -> list[Panel]:
    panels: list[Panel] = []

    def add_solid_span(start: float, end: float) -> None:
        if end <= start:
            return
        if end - start < materials.min_cut_width:
            panels.append(Panel(wall.id, start, end, end - start, None))
            return
        sizes = optimize_span(
            end - start,
            materials.standard_widths,
            materials.joint_gap,
            materials.primary_width,
            materials.min_cut_width,
            materials.cut_step,
            materials.end_tolerance,
            tolerance,
        )
        span_cursor = start
        for index, size in enumerate(sizes):
            nominal_end = span_cursor + size.width
            panel_end = end if index == len(sizes) - 1 else nominal_end
            panels.append(
                Panel(
                    wall_id=wall.id,
                    start_offset=span_cursor,
                    end_offset=panel_end,
                    width=size.width,
                    standard_width=size.standard_width,
                    fit_adjustment=panel_end - nominal_end,
                )
            )
            span_cursor = panel_end + (
                materials.joint_gap if index < len(sizes) - 1 else 0.0
            )

    cursor = 0.0
    for opening in sorted(wall.openings, key=lambda item: item.start_offset):
        add_solid_span(cursor, opening.start_offset)
        cursor = max(cursor, opening.end_offset)
    add_solid_span(cursor, wall.length)
    return panels
