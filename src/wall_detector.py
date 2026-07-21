from __future__ import annotations

from collections import Counter, defaultdict
from dataclasses import dataclass, replace
from math import atan2, cos, degrees, radians, sin
from typing import Any, Iterable

from ezdxf import bbox
from ezdxf.document import Drawing

from .config import DEFAULT_CONFIG, DrawingConfig
from .geometry import Point, distance

OPENING_WORDS = ("DOOR", "WINDOW", "GATE", "门", "窗")


@dataclass(frozen=True)
class OpeningSpan:
    start_offset: float
    end_offset: float
    kind: str
    id: str = ""
    confidence: float = 1.0
    evidence: tuple[str, ...] = ()
    source_hint: str = "geometry"


@dataclass(frozen=True)
class WallSegment:
    id: str
    start: Point
    end: Point
    thickness: float
    openings: tuple[OpeningSpan, ...] = ()
    source_layer: str = ""
    confidence: float = 1.0
    evidence: tuple[str, ...] = ()
    wall_type: str = "local_panel_wall"

    @property
    def length(self) -> float:
        return distance(self.start, self.end)


@dataclass(frozen=True)
class DetectionResult:
    walls: tuple[WallSegment, ...]
    thickness_counts: tuple[tuple[int, int], ...]
    skipped_curves: int
    face_count: int


@dataclass(frozen=True)
class _Face:
    start: Point
    end: Point
    layer: str
    recoverable: bool


@dataclass(frozen=True)
class _ProjectedFace:
    layer: str
    angle_key: int
    offset: float
    start: float
    end: float
    recoverable: bool


@dataclass(frozen=True)
class _Axis:
    start: Point
    end: Point
    thickness: float
    layer: str
    openings: tuple[OpeningSpan, ...] = ()
    confirmed: bool = True

    @property
    def length(self) -> float:
        return distance(self.start, self.end)


@dataclass(frozen=True)
class _OpeningLine:
    start: Point
    end: Point


@dataclass(frozen=True)
class _OpeningArc:
    center: Point
    radius: float
    start: Point
    end: Point


def _valid_unicode(value: Any) -> str:
    text = str(value)
    try:
        text = text.encode("cp1252", errors="surrogateescape").decode("utf-8")
    except (UnicodeEncodeError, UnicodeDecodeError):
        pass
    return "".join("\ufffd" if 0xD800 <= ord(character) <= 0xDFFF else character for character in text)


def _canonical(start: Point, end: Point) -> tuple[Point, Point]:
    if end < start:
        return end, start
    return start, end


def _resolve_layer(doc: Drawing, layer_name: str) -> Any | None:
    if layer_name in doc.layers:
        return doc.layers.get(layer_name)
    leaf_name = layer_name.rsplit("$0$", 1)[-1]
    return next(
        (
            layer
            for layer in doc.layers
            if str(layer.dxf.name).rsplit("$0$", 1)[-1] == leaf_name
        ),
        None,
    )


def _layer_is_visible(doc: Drawing, layer_name: str) -> bool:
    layer = _resolve_layer(doc, layer_name)
    if layer is None:
        return True
    return not layer.is_off() and not layer.is_frozen()


def _effective_layer(entity: Any, inherited_layer: str) -> str:
    layer = _valid_unicode(entity.dxf.get("layer", "0"))
    return inherited_layer if layer == "0" and inherited_layer != "0" else layer


def _effective_color(doc: Drawing, entity: Any, layer: str) -> int:
    color = int(entity.dxf.get("color", 256))
    resolved_layer = _resolve_layer(doc, layer)
    if color == 256 and resolved_layer is not None:
        return int(resolved_layer.color)
    return color


def _is_opening_insert(entity: Any, layer: str) -> bool:
    name = f"{_valid_unicode(entity.dxf.name)} {layer.rsplit('$0$', 1)[-1]}".casefold()
    return any(word.casefold() in name for word in OPENING_WORDS)


def _iter_entities(
    doc: Drawing,
    entities: Iterable[Any],
    inherited_layer: str = "0",
) -> Iterable[tuple[Any, str]]:
    for entity in entities:
        layer = _effective_layer(entity, inherited_layer)
        if not _layer_is_visible(doc, layer):
            continue
        if entity.dxftype() == "INSERT" and not _is_opening_insert(entity, layer):
            yield from _iter_entities(doc, entity.virtual_entities(), layer)
        elif entity.dxftype() != "INSERT":
            yield entity, layer


def _iter_all_entities(
    doc: Drawing,
    entities: Iterable[Any],
    inherited_layer: str = "0",
) -> Iterable[tuple[Any, str]]:
    for entity in entities:
        layer = _effective_layer(entity, inherited_layer)
        if not _layer_is_visible(doc, layer):
            continue
        if entity.dxftype() == "INSERT":
            yield from _iter_all_entities(doc, entity.virtual_entities(), layer)
        else:
            yield entity, layer


def _add_polyline_faces(
    faces: list[_Face],
    points: list[tuple[float, float, float]],
    closed: bool,
    layer: str,
    recoverable: bool,
    tolerance: float,
) -> int:
    skipped_curves = 0
    count = len(points) if closed else len(points) - 1
    for index in range(max(0, count)):
        start = points[index]
        end = points[(index + 1) % len(points)]
        if abs(start[2]) > tolerance:
            skipped_curves += 1
            continue
        a, b = _canonical((start[0], start[1]), (end[0], end[1]))
        if distance(a, b) > tolerance:
            faces.append(_Face(a, b, layer, recoverable))
    return skipped_curves


def _extract_faces(
    doc: Drawing,
    config: DrawingConfig,
    door_line_keys: set[tuple[Point, Point]] | None = None,
    include_all_colors: bool = False,
) -> tuple[list[_Face], int]:
    faces: list[_Face] = []
    skipped_curves = 0
    excluded_lines = door_line_keys or set()
    for entity, layer in _iter_entities(doc, doc.modelspace()):
        recoverable = _effective_color(doc, entity, layer) in config.wall_colors
        if not include_all_colors and not recoverable:
            continue
        entity_type = entity.dxftype()
        if entity_type == "LINE":
            start, end = entity.dxf.start, entity.dxf.end
            a, b = _canonical((float(start.x), float(start.y)), (float(end.x), float(end.y)))
            if distance(a, b) > config.tolerance and (a, b) not in excluded_lines:
                faces.append(_Face(a, b, layer, recoverable))
        elif entity_type == "LWPOLYLINE":
            points = [(float(x), float(y), float(bulge)) for x, y, bulge in entity.get_points("xyb")]
            skipped_curves += _add_polyline_faces(
                faces, points, bool(entity.closed), layer, recoverable, config.tolerance
            )
        elif entity_type == "POLYLINE" and entity.get_mode() in {"AcDb2dPolyline", "AcDb3dPolyline"}:
            points = [
                (
                    float(vertex.dxf.location.x),
                    float(vertex.dxf.location.y),
                    float(vertex.dxf.get("bulge", 0.0)),
                )
                for vertex in entity.vertices
            ]
            skipped_curves += _add_polyline_faces(
                faces, points, bool(entity.is_closed), layer, recoverable, config.tolerance
            )
    return faces, skipped_curves


def _extract_opening_markers(
    doc: Drawing,
    config: DrawingConfig,
) -> tuple[list[_OpeningLine], list[_OpeningArc]]:
    lines: list[_OpeningLine] = []
    arcs: list[_OpeningArc] = []
    for entity, layer in _iter_all_entities(doc, doc.modelspace()):
        entity_type = entity.dxftype()
        if entity_type == "LINE":
            start, end = entity.dxf.start, entity.dxf.end
            a = float(start.x), float(start.y)
            b = float(end.x), float(end.y)
            if distance(a, b) >= config.opening_min_width:
                lines.append(_OpeningLine(a, b))
        elif entity_type == "LWPOLYLINE":
            points = [(float(x), float(y), float(bulge)) for x, y, bulge in entity.get_points("xyb")]
            for start, end in zip(points, points[1:]):
                if abs(start[2]) <= config.tolerance:
                    a, b = (start[0], start[1]), (end[0], end[1])
                    if distance(a, b) >= config.opening_min_width:
                        lines.append(_OpeningLine(a, b))
        elif entity_type == "ARC":
            center = entity.ocs().to_wcs(entity.dxf.center)
            start, end = entity.start_point, entity.end_point
            arcs.append(
                _OpeningArc(
                    (float(center.x), float(center.y)),
                    float(entity.dxf.radius),
                    (float(start.x), float(start.y)),
                    (float(end.x), float(end.y)),
                )
            )
    return lines, arcs


def _matching_door_lines(
    arc: _OpeningArc,
    lines: list[_OpeningLine],
    tolerance: float,
) -> list[_OpeningLine]:
    return [
        line
        for line in lines
        if abs(distance(line.start, line.end) - arc.radius) <= tolerance
        and min(distance(line.start, arc.center), distance(line.end, arc.center)) <= tolerance
        and min(
            distance(line.start, arc.start),
            distance(line.start, arc.end),
            distance(line.end, arc.start),
            distance(line.end, arc.end),
        )
        <= tolerance
    ]


def _door_line_keys(
    lines: list[_OpeningLine],
    arcs: list[_OpeningArc],
    config: DrawingConfig,
) -> set[tuple[Point, Point]]:
    keys: set[tuple[Point, Point]] = set()
    for arc in arcs:
        matches = _matching_door_lines(arc, lines, config.opening_alignment_tolerance)
        if len(matches) >= 2:
            keys.update(_canonical(line.start, line.end) for line in matches)
    return keys


def _angle_key(start: Point, end: Point, step: float) -> int:
    angle = degrees(atan2(end[1] - start[1], end[0] - start[0])) % 180.0
    return round(angle / step)


def _basis(angle_key: int, step: float) -> tuple[Point, Point]:
    angle = radians(angle_key * step)
    unit = cos(angle), sin(angle)
    return unit, (-unit[1], unit[0])


def _project_faces(faces: list[_Face], config: DrawingConfig) -> list[_ProjectedFace]:
    groups: dict[tuple[str, int, int, bool], list[tuple[float, float, float]]] = defaultdict(list)
    for face in faces:
        angle_key = _angle_key(face.start, face.end, config.angle_tolerance)
        unit, normal = _basis(angle_key, config.angle_tolerance)
        start = face.start[0] * unit[0] + face.start[1] * unit[1]
        end = face.end[0] * unit[0] + face.end[1] * unit[1]
        offset = (
            face.start[0] * normal[0]
            + face.start[1] * normal[1]
            + face.end[0] * normal[0]
            + face.end[1] * normal[1]
        ) / 2.0
        key = (face.layer, angle_key, round(offset / config.snap_tolerance), face.recoverable)
        groups[key].append((min(start, end), max(start, end), offset))

    projected: list[_ProjectedFace] = []
    for (layer, angle_key, _, recoverable), intervals in groups.items():
        intervals.sort()
        start, end, offset = intervals[0]
        offsets = [offset]
        for next_start, next_end, next_offset in intervals[1:]:
            if next_start <= end + config.snap_tolerance:
                end = max(end, next_end)
                offsets.append(next_offset)
            else:
                projected.append(
                    _ProjectedFace(
                        layer,
                        angle_key,
                        sum(offsets) / len(offsets),
                        start,
                        end,
                        recoverable,
                    )
                )
                start, end, offsets = next_start, next_end, [next_offset]
        projected.append(
            _ProjectedFace(
                layer,
                angle_key,
                sum(offsets) / len(offsets),
                start,
                end,
                recoverable,
            )
        )
    return projected


def _merge_support(intervals: list[tuple[float, float]], tolerance: float) -> list[tuple[float, float]]:
    merged: list[tuple[float, float]] = []
    for start, end in sorted(intervals):
        if merged and start <= merged[-1][1] + tolerance:
            merged[-1] = merged[-1][0], max(merged[-1][1], end)
        else:
            merged.append((start, end))
    return merged


def _pair_faces(
    faces: list[_ProjectedFace],
    config: DrawingConfig,
) -> tuple[list[_Axis], Counter[int]]:
    groups: dict[tuple[str, int], list[_ProjectedFace]] = defaultdict(list)
    for face in faces:
        groups[(face.layer, face.angle_key)].append(face)

    axes: list[_Axis] = []
    thickness_counts: Counter[int] = Counter()
    for (layer, angle_key), group in groups.items():
        candidates: list[tuple[int, int, float]] = []
        nearest: dict[int, float] = {}
        for index, face in enumerate(group):
            face_length = face.end - face.start
            for other_index in range(index + 1, len(group)):
                other = group[other_index]
                thickness = abs(other.offset - face.offset)
                if not any(
                    abs(thickness - allowed) <= config.wall_thickness_tolerance
                    for allowed in config.wall_thicknesses
                ):
                    continue
                overlap = min(face.end, other.end) - max(face.start, other.start)
                if overlap < config.min_wall_length:
                    continue
                coverage = overlap / min(face_length, other.end - other.start)
                if coverage < config.parallel_overlap_ratio:
                    continue
                candidates.append((index, other_index, thickness))
                nearest[index] = min(nearest.get(index, thickness), thickness)
                nearest[other_index] = min(nearest.get(other_index, thickness), thickness)

        unit, normal = _basis(angle_key, config.angle_tolerance)
        recovered_bands: set[tuple[int, int]] = set()
        seed_intervals: dict[tuple[int, int], list[tuple[float, float]]] = defaultdict(list)
        for index, other_index, thickness in candidates:
            if (
                thickness > nearest[index] + config.tolerance
                or thickness > nearest[other_index] + config.tolerance
            ):
                continue
            first, second = group[index], group[other_index]
            if first.recoverable and second.recoverable:
                band = tuple(
                    sorted(
                        (
                            round(first.offset / config.snap_tolerance),
                            round(second.offset / config.snap_tolerance),
                        )
                    )
                )
                recovered_bands.add(band)
                seed_intervals[band].append(
                    (max(first.start, second.start), min(first.end, second.end))
                )
                continue
            start = max(first.start, second.start)
            end = min(first.end, second.end)
            offset = (first.offset + second.offset) / 2.0
            a = (unit[0] * start + normal[0] * offset, unit[1] * start + normal[1] * offset)
            b = (unit[0] * end + normal[0] * offset, unit[1] * end + normal[1] * offset)
            a, b = _canonical(a, b)
            axes.append(_Axis(a, b, thickness, layer))
            thickness_counts[round(thickness)] += 1

        for first_key, second_key in recovered_bands:
            first_row = [
                face
                for face in group
                if face.recoverable
                and round(face.offset / config.snap_tolerance) == first_key
            ]
            second_row = [
                face
                for face in group
                if face.recoverable
                and round(face.offset / config.snap_tolerance) == second_key
            ]
            first_offset = sum(face.offset for face in first_row) / len(first_row)
            second_offset = sum(face.offset for face in second_row) / len(second_row)
            center = (first_offset + second_offset) / 2.0
            thickness = abs(second_offset - first_offset)
            support = _merge_support(
                [(face.start, face.end) for face in (*first_row, *second_row)],
                config.snap_tolerance,
            )
            for start, end in support:
                a = unit[0] * start + normal[0] * center, unit[1] * start + normal[1] * center
                b = unit[0] * end + normal[0] * center, unit[1] * end + normal[1] * center
                confirmed = any(
                    min(end, seed_end) - max(start, seed_start) > config.tolerance
                    for seed_start, seed_end in seed_intervals[(first_key, second_key)]
                )
                axes.append(_Axis(*_canonical(a, b), thickness, layer, confirmed=confirmed))
                thickness_counts[round(thickness)] += 1
    return axes, thickness_counts


def _merge_openings(
    openings: list[tuple[float, float, str]],
    tolerance: float,
) -> list[tuple[float, float, str]]:
    merged: list[tuple[float, float, str]] = []
    for start, end, kind in sorted(openings):
        if merged and start <= merged[-1][1] + tolerance:
            previous_start, previous_end, previous_kind = merged[-1]
            merged[-1] = (
                previous_start,
                max(previous_end, end),
                "door" if "door" in {previous_kind, kind} else "window",
            )
        else:
            merged.append((start, end, kind))
    return merged


def _gap_openings(
    angle_key: int,
    offset: float,
    gap_start: float,
    gap_end: float,
    opening_lines: list[_OpeningLine],
    opening_arcs: list[_OpeningArc],
    config: DrawingConfig,
    require_gap_coverage: bool = True,
) -> list[tuple[float, float, str]]:
    unit, normal = _basis(angle_key, config.angle_tolerance)
    line_groups: dict[tuple[int, int], list[tuple[float, float]]] = defaultdict(list)
    for line in opening_lines:
        if _angle_key(line.start, line.end, config.angle_tolerance) != angle_key:
            continue
        start_normal = line.start[0] * normal[0] + line.start[1] * normal[1]
        end_normal = line.end[0] * normal[0] + line.end[1] * normal[1]
        if (
            max(abs(start_normal - offset), abs(end_normal - offset))
            > config.opening_alignment_tolerance
        ):
            continue
        values = sorted(
            (
                line.start[0] * unit[0] + line.start[1] * unit[1],
                line.end[0] * unit[0] + line.end[1] * unit[1],
            )
        )
        if not config.opening_min_width <= values[1] - values[0] <= config.opening_max_width:
            continue
        key = (
            round(values[0] / config.snap_tolerance),
            round(values[1] / config.snap_tolerance),
        )
        line_groups[key].append((values[0], values[1]))

    candidates: list[tuple[float, float, str]] = []
    for group in line_groups.values():
        if len(group) < 4:
            continue
        candidates.append(
            (
                sum(item[0] for item in group) / len(group),
                sum(item[1] for item in group) / len(group),
                "window",
            )
        )

    for arc in opening_arcs:
        center = arc.center[0] * unit[0] + arc.center[1] * unit[1]
        center_normal = arc.center[0] * normal[0] + arc.center[1] * normal[1]
        if abs(center_normal - offset) > config.opening_alignment_tolerance:
            continue
        endpoints = (
            arc.start[0] * unit[0] + arc.start[1] * unit[1],
            arc.end[0] * unit[0] + arc.end[1] * unit[1],
        )
        matching_lines = _matching_door_lines(
            arc,
            opening_lines,
            config.opening_alignment_tolerance,
        )
        if len(matching_lines) < 2:
            continue
        line_positions = [
            point[0] * unit[0] + point[1] * unit[1]
            for line in matching_lines
            for point in (line.start, line.end)
        ]
        if center - min(endpoints) >= max(endpoints) - center:
            opening = min(endpoints), max(line_positions)
        else:
            opening = min(line_positions), max(endpoints)
        if config.opening_min_width <= opening[1] - opening[0] <= config.opening_max_width:
            candidates.append((*opening, "door"))

    overlapping = [
        (start, end, kind)
        for start, end, kind in candidates
        if min(end, gap_end) - max(start, gap_start) >= config.opening_min_width
    ]
    if not require_gap_coverage:
        return _merge_openings(overlapping, config.tolerance)
    openings = _merge_openings(
        [
            (max(start, gap_start), min(end, gap_end), kind)
            for start, end, kind in overlapping
        ],
        config.tolerance,
    )
    covered_until = gap_start
    for start, end, _ in openings:
        if start > covered_until + config.opening_jamb_tolerance:
            return []
        covered_until = max(covered_until, end)
    if covered_until < gap_end - config.opening_jamb_tolerance:
        return []
    return _merge_openings(overlapping, config.tolerance)


def _all_projected_openings(
    angle_key: int,
    offset: float,
    start: float,
    end: float,
    openings: list[tuple[float, float, str]],
    opening_lines: list[_OpeningLine],
    opening_arcs: list[_OpeningArc],
    config: DrawingConfig,
) -> list[tuple[float, float, str]]:
    return _merge_openings(
        [
            *openings,
            *_gap_openings(
                angle_key,
                offset,
                start,
                end,
                opening_lines,
                opening_arcs,
                config,
                require_gap_coverage=False,
            ),
        ],
        config.tolerance,
    )


def _projected_axis(
    layer: str,
    angle_key: int,
    start: float,
    end: float,
    center: float,
    thickness: float,
    openings: list[tuple[float, float, str]],
    config: DrawingConfig,
) -> _Axis:
    unit, normal = _basis(angle_key, config.angle_tolerance)
    first = unit[0] * start + normal[0] * center, unit[1] * start + normal[1] * center
    second = unit[0] * end + normal[0] * center, unit[1] * end + normal[1] * center
    first, second = _canonical(first, second)
    direction = (
        (second[0] - first[0]) / distance(first, second),
        (second[1] - first[1]) / distance(first, second),
    )
    relative = []
    for opening_start, opening_end, kind in openings:
        points = (
            (unit[0] * opening_start + normal[0] * center, unit[1] * opening_start + normal[1] * center),
            (unit[0] * opening_end + normal[0] * center, unit[1] * opening_end + normal[1] * center),
        )
        offsets = sorted(
            (
                (point[0] - first[0]) * direction[0] + (point[1] - first[1]) * direction[1]
                for point in points
            )
        )
        relative.append(OpeningSpan(offsets[0], offsets[1], kind))
    return _Axis(
        first,
        second,
        thickness,
        layer,
        tuple(sorted(relative, key=lambda item: item.start_offset)),
    )


def _merge_axes(
    axes: list[_Axis],
    opening_lines: list[_OpeningLine],
    opening_arcs: list[_OpeningArc],
    config: DrawingConfig,
) -> list[_Axis]:
    groups: dict[
        tuple[str, int, int],
        list[tuple[float, float, float, float, bool]],
    ] = defaultdict(list)
    for axis in axes:
        angle_key = _angle_key(axis.start, axis.end, config.angle_tolerance)
        unit, normal = _basis(angle_key, config.angle_tolerance)
        start = axis.start[0] * unit[0] + axis.start[1] * unit[1]
        end = axis.end[0] * unit[0] + axis.end[1] * unit[1]
        offset = (
            axis.start[0] * normal[0]
            + axis.start[1] * normal[1]
            + axis.end[0] * normal[0]
            + axis.end[1] * normal[1]
        ) / 2.0
        key = axis.layer, angle_key, round(offset / config.snap_tolerance)
        groups[key].append(
            (min(start, end), max(start, end), offset, axis.thickness, axis.confirmed)
        )

    merged: list[_Axis] = []
    for (layer, angle_key, _), intervals in groups.items():
        intervals.sort()
        start, end, offset, thickness, confirmed = intervals[0]
        offsets, thicknesses = [offset], [thickness]
        openings: list[tuple[float, float, str]] = []
        for next_start, next_end, next_offset, next_thickness, next_confirmed in intervals[1:]:
            if next_start <= end + max(thickness, next_thickness) + config.snap_tolerance:
                end = max(end, next_end)
                offsets.append(next_offset)
                thicknesses.append(next_thickness)
                confirmed = confirmed or next_confirmed
            else:
                center = sum(offsets) / len(offsets)
                average_thickness = sum(thicknesses) / len(thicknesses)
                gap_openings = (
                    _gap_openings(
                        angle_key,
                        (center + next_offset) / 2.0,
                        end,
                        next_start,
                        opening_lines,
                        opening_arcs,
                        config,
                    )
                    if next_start - end >= config.opening_min_width
                    else []
                )
                if gap_openings:
                    openings.extend(gap_openings)
                    end = next_end
                    offsets.append(next_offset)
                    thicknesses.append(next_thickness)
                    confirmed = confirmed or next_confirmed
                else:
                    openings = _all_projected_openings(
                        angle_key,
                        center,
                        start,
                        end,
                        openings,
                        opening_lines,
                        opening_arcs,
                        config,
                    )
                    if confirmed:
                        merged.append(
                            _projected_axis(
                                layer,
                                angle_key,
                                start,
                                end,
                                center,
                                average_thickness,
                                openings,
                                config,
                            )
                        )
                    start, end = next_start, next_end
                    offsets, thicknesses, openings = [next_offset], [next_thickness], []
                    confirmed = next_confirmed
        center = sum(offsets) / len(offsets)
        openings = _all_projected_openings(
            angle_key,
            center,
            start,
            end,
            openings,
            opening_lines,
            opening_arcs,
            config,
        )
        if confirmed:
            merged.append(
                _projected_axis(
                    layer,
                    angle_key,
                    start,
                    end,
                    center,
                    sum(thicknesses) / len(thicknesses),
                    openings,
                    config,
                )
            )
    return merged


def _cross(first: Point, second: Point) -> float:
    return first[0] * second[1] - first[1] * second[0]


def _intersection_distances(first: _Axis, second: _Axis) -> tuple[float, float] | None:
    first_length, second_length = first.length, second.length
    first_unit = (
        (first.end[0] - first.start[0]) / first_length,
        (first.end[1] - first.start[1]) / first_length,
    )
    second_unit = (
        (second.end[0] - second.start[0]) / second_length,
        (second.end[1] - second.start[1]) / second_length,
    )
    denominator = _cross(first_unit, second_unit)
    if abs(denominator) < 1e-9:
        return None
    delta = second.start[0] - first.start[0], second.start[1] - first.start[1]
    return _cross(delta, second_unit) / denominator, _cross(delta, first_unit) / denominator


def _point_on_axis(axis: _Axis, offset: float) -> Point:
    length = axis.length
    return (
        axis.start[0] + (axis.end[0] - axis.start[0]) * offset / length,
        axis.start[1] + (axis.end[1] - axis.start[1]) * offset / length,
    )


def _split_at_intersections(axes: list[_Axis], config: DrawingConfig) -> list[WallSegment]:
    cuts: list[list[float]] = [[] for _ in axes]
    start_reserves = [0.0 for _ in axes]
    end_reserves = [0.0 for _ in axes]

    # ponytail: quadratic scan is simpler and fast enough for floor plans; add a spatial index above ~10k axes.
    for first_index, first in enumerate(axes):
        for second_index in range(first_index + 1, len(axes)):
            second = axes[second_index]
            intersection = _intersection_distances(first, second)
            if intersection is None:
                continue
            first_offset, second_offset = intersection
            first_extension = first.thickness / 2.0 + config.snap_tolerance
            second_extension = second.thickness / 2.0 + config.snap_tolerance
            if not (-first_extension <= first_offset <= first.length + first_extension):
                continue
            if not (-second_extension <= second_offset <= second.length + second_extension):
                continue

            first_at_end = (
                first_offset <= config.snap_tolerance
                or first_offset >= first.length - config.snap_tolerance
            )
            second_at_end = (
                second_offset <= config.snap_tolerance
                or second_offset >= second.length - config.snap_tolerance
            )
            if not first_at_end and not second_at_end:
                cuts[first_index].extend(
                    (
                        first_offset - second.thickness / 2.0,
                        first_offset + second.thickness / 2.0,
                    )
                )
                cuts[second_index].extend(
                    (
                        second_offset - first.thickness / 2.0,
                        second_offset + first.thickness / 2.0,
                    )
                )
            if first_at_end != second_at_end:
                branch_index, branch_offset, branch_length = (
                    (first_index, first_offset, first.length)
                    if first_at_end
                    else (second_index, second_offset, second.length)
                )
                if branch_offset <= branch_length / 2.0:
                    start_reserves[branch_index] = max(
                        start_reserves[branch_index], config.junction_reserve
                    )
                else:
                    end_reserves[branch_index] = max(
                        end_reserves[branch_index], config.junction_reserve
                    )

    pieces: dict[
        tuple[tuple[int, int], tuple[int, int]],
        tuple[Point, Point, float, tuple[OpeningSpan, ...], str],
    ] = {}
    for index, axis in enumerate(axes):
        positions = [
            start_reserves[index],
            axis.length - end_reserves[index],
        ]
        positions.extend(
            offset
            for offset in cuts[index]
            if start_reserves[index] + config.tolerance
            < offset
            < axis.length - end_reserves[index] - config.tolerance
        )
        positions.sort()
        unique = [positions[0]]
        for position in positions[1:]:
            if position - unique[-1] > config.tolerance:
                unique.append(position)
        for start_offset, end_offset in zip(unique, unique[1:]):
            if end_offset - start_offset < config.min_wall_length:
                continue
            start, end = _canonical(_point_on_axis(axis, start_offset), _point_on_axis(axis, end_offset))
            key = (
                (round(start[0] / config.snap_tolerance), round(start[1] / config.snap_tolerance)),
                (round(end[0] / config.snap_tolerance), round(end[1] / config.snap_tolerance)),
            )
            openings = tuple(
                OpeningSpan(
                    opening.start_offset - start_offset,
                    opening.end_offset - start_offset,
                    opening.kind,
                )
                for opening in axis.openings
                if opening.start_offset >= start_offset - config.tolerance
                and opening.end_offset <= end_offset + config.tolerance
            )
            pieces.setdefault(key, (start, end, axis.thickness, openings, axis.layer))

    ordered = sorted(
        pieces.values(),
        key=lambda item: (
            round(item[0][0], 3),
            round(item[0][1], 3),
            round(degrees(atan2(item[1][1] - item[0][1], item[1][0] - item[0][0])) % 180, 3),
            round(distance(item[0], item[1]), 3),
        ),
    )
    result: list[WallSegment] = []
    opening_index = 1
    for index, (start, end, thickness, openings, layer) in enumerate(ordered, 1):
        identified_openings = tuple(
            OpeningSpan(
                opening.start_offset,
                opening.end_offset,
                opening.kind,
                f"O{opening_index + offset:04d}",
                source_hint=opening.source_hint,
            )
            for offset, opening in enumerate(openings)
        )
        opening_index += len(openings)
        result.append(
            WallSegment(
                f"W{index:04d}",
                start,
                end,
                thickness,
                identified_openings,
                source_layer=layer,
            )
        )
    return result


def _add_block_opening_candidates(
    doc: Drawing,
    walls: list[WallSegment],
    config: DrawingConfig,
) -> list[WallSegment]:
    next_id = 1 + max(
        (int(opening.id[1:]) for wall in walls for opening in wall.openings if opening.id),
        default=0,
    )
    additions: dict[str, list[OpeningSpan]] = defaultdict(list)
    for entity in doc.modelspace().query("INSERT"):
        layer = _valid_unicode(entity.dxf.get("layer", "0"))
        if not _layer_is_visible(doc, layer):
            continue
        extents = bbox.extents([entity], fast=True)
        if not extents.has_data:
            continue
        box = (
            float(extents.extmin.x),
            float(extents.extmin.y),
            float(extents.extmax.x),
            float(extents.extmax.y),
        )
        center = ((box[0] + box[2]) / 2.0, (box[1] + box[3]) / 2.0)
        best: tuple[float, WallSegment, float, float] | None = None
        for wall in walls:
            unit = (
                (wall.end[0] - wall.start[0]) / wall.length,
                (wall.end[1] - wall.start[1]) / wall.length,
            )
            normal = (-unit[1], unit[0])
            relative = (center[0] - wall.start[0], center[1] - wall.start[1])
            perpendicular = abs(relative[0] * normal[0] + relative[1] * normal[1])
            if perpendicular > config.opening_alignment_tolerance:
                continue
            offsets = [
                (x - wall.start[0]) * unit[0] + (y - wall.start[1]) * unit[1]
                for x, y in (
                    (box[0], box[1]),
                    (box[0], box[3]),
                    (box[2], box[1]),
                    (box[2], box[3]),
                )
            ]
            start, end = max(0.0, min(offsets)), min(wall.length, max(offsets))
            if not config.opening_min_width <= end - start <= config.opening_max_width:
                continue
            candidate = perpendicular, wall, start, end
            if best is None or candidate[0] < best[0]:
                best = candidate
        if best is None:
            continue
        _, wall, start, end = best
        existing = (*wall.openings, *additions[wall.id])
        if any(
            min(end, opening.end_offset) - max(start, opening.start_offset)
            >= 0.8 * min(end - start, opening.end_offset - opening.start_offset)
            for opening in existing
        ):
            continue
        hint = f"block={_valid_unicode(entity.dxf.name)}; layer={layer}"
        additions[wall.id].append(OpeningSpan(start, end, "other", f"O{next_id:04d}", source_hint=hint))
        next_id += 1
    return [
        replace(
            wall,
            openings=tuple(sorted((*wall.openings, *additions[wall.id]), key=lambda item: item.start_offset)),
        )
        for wall in walls
    ]


def detect_walls(
    doc: Drawing,
    config: DrawingConfig = DEFAULT_CONFIG,
    include_all_colors: bool = False,
) -> DetectionResult:
    opening_lines, opening_arcs = _extract_opening_markers(doc, config)
    faces, skipped_curves = _extract_faces(
        doc,
        config,
        _door_line_keys(opening_lines, opening_arcs, config),
        include_all_colors,
    )
    projected = _project_faces(faces, config)
    axes, thickness_counts = _pair_faces(projected, config)
    walls = _split_at_intersections(
        _merge_axes(axes, opening_lines, opening_arcs, config),
        config,
    )
    if include_all_colors:
        walls = _add_block_opening_candidates(doc, walls, config)
    return DetectionResult(tuple(walls), tuple(thickness_counts.most_common()), skipped_curves, len(faces))
