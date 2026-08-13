from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from math import atan2, degrees, floor, hypot
from typing import Iterable

from ezdxf.document import Drawing
from ezdxf.enums import MTextEntityAlignment
from ezdxf.math import Vec2
from ezdxf.math.clipping import ConvexClippingPolygon2d

from .config import DEFAULT_CEILING_CONFIG, CeilingConfig
from .geometry import Point
from .wall_detector import WallSegment

CEILING_LAYERS = {
    "CEILING_BOUNDARY": 3,
    "CEILING_PANEL": 3,
    "CEILING_TEXT": 4,
}
SNAP_TOLERANCE = 1.0


@dataclass(frozen=True)
class CeilingPanel:
    vertices: tuple[Point, ...]
    width: float
    length: float
    length_axis: Point


@dataclass(frozen=True)
class CeilingLayout:
    boundaries: tuple[tuple[Point, ...], ...]
    panels: tuple[CeilingPanel, ...]


@dataclass(frozen=True)
class _LayoutPlan:
    panels: tuple[CeilingPanel, ...]
    length_axis: Point
    width_axis: Point
    origin: Point


@dataclass(frozen=True)
class _Edge:
    start: Point
    end: Point
    thickness: float

    @property
    def length(self) -> float:
        return hypot(self.end[0] - self.start[0], self.end[1] - self.start[1])


def _cross(first: Point, second: Point) -> float:
    return first[0] * second[1] - first[1] * second[0]


def _signed_area(vertices: list[Point] | tuple[Point, ...]) -> float:
    return sum(
        first[0] * second[1] - second[0] * first[1]
        for first, second in zip(vertices, (*vertices[1:], vertices[0]))
    ) / 2.0


def _centroid(vertices: tuple[Point, ...]) -> Point:
    area_sum = 0.0
    x_sum = 0.0
    y_sum = 0.0
    for first, second in zip(vertices, (*vertices[1:], vertices[0])):
        cross = first[0] * second[1] - second[0] * first[1]
        area_sum += cross
        x_sum += (first[0] + second[0]) * cross
        y_sum += (first[1] + second[1]) * cross
    if abs(area_sum) <= SNAP_TOLERANCE:
        return (
            sum(point[0] for point in vertices) / len(vertices),
            sum(point[1] for point in vertices) / len(vertices),
        )
    return x_sum / (3.0 * area_sum), y_sum / (3.0 * area_sum)


def _intersection(first: _Edge, second: _Edge) -> tuple[float, float] | None:
    first_vector = first.end[0] - first.start[0], first.end[1] - first.start[1]
    second_vector = second.end[0] - second.start[0], second.end[1] - second.start[1]
    denominator = _cross(first_vector, second_vector)
    if abs(denominator) < first.length * second.length * 1e-9:
        return None
    delta = second.start[0] - first.start[0], second.start[1] - first.start[1]
    return _cross(delta, second_vector) / denominator, _cross(delta, first_vector) / denominator


def _point_at(edge: _Edge, position: float) -> Point:
    return (
        edge.start[0] + (edge.end[0] - edge.start[0]) * position,
        edge.start[1] + (edge.end[1] - edge.start[1]) * position,
    )


def _edge_key(start: Point, end: Point) -> tuple[Point, Point]:
    return (start, end) if start < end else (end, start)


def _position_on_edge(edge: _Edge, point: Point) -> float | None:
    vector = edge.end[0] - edge.start[0], edge.end[1] - edge.start[1]
    delta = point[0] - edge.start[0], point[1] - edge.start[1]
    if abs(_cross(vector, delta)) > edge.length * SNAP_TOLERANCE:
        return None
    return (delta[0] * vector[0] + delta[1] * vector[1]) / edge.length**2


def _restore_graph(
    walls: Iterable[WallSegment],
    junction_reserve: float,
) -> dict[tuple[Point, Point], _Edge]:
    sources = [_Edge(wall.start, wall.end, wall.thickness) for wall in walls]
    cuts = [[0.0, 1.0] for _ in sources]

    # ponytail: quadratic intersection scan is enough for floor plans; add a spatial
    # index only if real projects reach thousands of accepted wall segments.
    for first_index, first in enumerate(sources):
        for second_index in range(first_index + 1, len(sources)):
            second = sources[second_index]
            intersection = _intersection(first, second)
            first_extension = (
                first.thickness / 2.0 + junction_reserve + SNAP_TOLERANCE
            ) / first.length
            second_extension = (
                second.thickness / 2.0 + junction_reserve + SNAP_TOLERANCE
            ) / second.length
            if intersection is None:
                first_positions = (
                    _position_on_edge(first, second.start),
                    _position_on_edge(first, second.end),
                )
                second_positions = (
                    _position_on_edge(second, first.start),
                    _position_on_edge(second, first.end),
                )
                if all(position is None for position in (*first_positions, *second_positions)):
                    continue
                cuts[first_index].extend(
                    position
                    for position in first_positions
                    if position is not None and -first_extension <= position <= 1.0 + first_extension
                )
                cuts[second_index].extend(
                    position
                    for position in second_positions
                    if position is not None and -second_extension <= position <= 1.0 + second_extension
                )
                continue
            first_position, second_position = intersection
            if not -first_extension <= first_position <= 1.0 + first_extension:
                continue
            if not -second_extension <= second_position <= 1.0 + second_extension:
                continue
            cuts[first_index].append(first_position)
            cuts[second_index].append(second_position)

    edges: dict[tuple[Point, Point], _Edge] = {}
    for source, positions in zip(sources, cuts):
        ordered = sorted(positions)
        unique = [ordered[0]]
        for position in ordered[1:]:
            if (position - unique[-1]) * source.length > SNAP_TOLERANCE:
                unique.append(position)
        for first_position, second_position in zip(unique, unique[1:]):
            start = _point_at(source, first_position)
            end = _point_at(source, second_position)
            if hypot(end[0] - start[0], end[1] - start[1]) <= SNAP_TOLERANCE:
                continue
            snapped_start = (
                round(start[0] / SNAP_TOLERANCE) * SNAP_TOLERANCE,
                round(start[1] / SNAP_TOLERANCE) * SNAP_TOLERANCE,
            )
            snapped_end = (
                round(end[0] / SNAP_TOLERANCE) * SNAP_TOLERANCE,
                round(end[1] / SNAP_TOLERANCE) * SNAP_TOLERANCE,
            )
            key = _edge_key(snapped_start, snapped_end)
            existing = edges.get(key)
            if existing is None or source.thickness > existing.thickness:
                edges[key] = _Edge(key[0], key[1], source.thickness)
    return edges


def _bounded_faces(edges: dict[tuple[Point, Point], _Edge]) -> list[list[Point]]:
    adjacency: dict[Point, list[Point]] = defaultdict(list)
    for start, end in edges:
        adjacency[start].append(end)
        adjacency[end].append(start)
    for vertex, neighbours in adjacency.items():
        neighbours.sort(key=lambda point: atan2(point[1] - vertex[1], point[0] - vertex[0]))

    visited: set[tuple[Point, Point]] = set()
    faces: list[list[Point]] = []
    for start, end in ((a, b) for edge in edges for a, b in (edge, edge[::-1])):
        if (start, end) in visited:
            continue
        face: list[Point] = []
        first = start, end
        previous, current = first
        while (previous, current) not in visited:
            visited.add((previous, current))
            face.append(previous)
            neighbours = adjacency[current]
            previous_index = neighbours.index(previous)
            following = neighbours[previous_index - 1]
            previous, current = current, following
        if (previous, current) == first and len(face) >= 3 and _signed_area(face) > SNAP_TOLERANCE:
            faces.append(face)
    return faces


def _line_intersection(first: tuple[Point, Point], second: tuple[Point, Point]) -> Point | None:
    first_vector = first[1][0] - first[0][0], first[1][1] - first[0][1]
    second_vector = second[1][0] - second[0][0], second[1][1] - second[0][1]
    denominator = _cross(first_vector, second_vector)
    if abs(denominator) < 1e-9:
        return None
    delta = second[0][0] - first[0][0], second[0][1] - first[0][1]
    position = _cross(delta, second_vector) / denominator
    return (
        first[0][0] + first_vector[0] * position,
        first[0][1] + first_vector[1] * position,
    )


def _ceiling_boundary(
    boundary: list[Point],
    thicknesses: dict[tuple[Point, Point], float],
    owned_edges: set[tuple[Point, Point]],
) -> list[Point]:
    if _signed_area(boundary) < 0:
        boundary.reverse()
    offset_lines: list[tuple[Point, Point]] = []
    for start, end in zip(boundary, (*boundary[1:], boundary[0])):
        length = hypot(end[0] - start[0], end[1] - start[1])
        normal = -(end[1] - start[1]) / length, (end[0] - start[0]) / length
        key = _edge_key(start, end)
        offset = thicknesses[key] / 2.0 * (-1 if key in owned_edges else 1)
        offset_lines.append(
            (
                (start[0] + normal[0] * offset, start[1] + normal[1] * offset),
                (end[0] + normal[0] * offset, end[1] + normal[1] * offset),
            )
        )

    result: list[Point] = []
    for previous, current in zip((offset_lines[-1], *offset_lines[:-1]), offset_lines):
        intersection = _line_intersection(previous, current)
        if intersection is None:
            intersection = (
                (previous[1][0] + current[0][0]) / 2.0,
                (previous[1][1] + current[0][1]) / 2.0,
            )
        if not result or hypot(intersection[0] - result[-1][0], intersection[1] - result[-1][1]) > SNAP_TOLERANCE:
            result.append(intersection)
    if len(result) < 3 or abs(_signed_area(result)) <= SNAP_TOLERANCE:
        raise ValueError("墙厚分配后没有有效吊顶区域")
    return result


def _axes(boundary: list[Point]) -> tuple[Point, Point]:
    longest = max(
        zip(boundary, (*boundary[1:], boundary[0])),
        key=lambda edge: hypot(edge[1][0] - edge[0][0], edge[1][1] - edge[0][1]),
    )
    length = hypot(longest[1][0] - longest[0][0], longest[1][1] - longest[0][1])
    axis = (longest[1][0] - longest[0][0]) / length, (longest[1][1] - longest[0][1]) / length
    if axis[0] < -1e-9 or (abs(axis[0]) <= 1e-9 and axis[1] < 0):
        axis = -axis[0], -axis[1]
    normal = -axis[1], axis[0]
    axis_span = max(point[0] * axis[0] + point[1] * axis[1] for point in boundary) - min(
        point[0] * axis[0] + point[1] * axis[1] for point in boundary
    )
    normal_span = max(point[0] * normal[0] + point[1] * normal[1] for point in boundary) - min(
        point[0] * normal[0] + point[1] * normal[1] for point in boundary
    )
    return (normal, (-normal[1], normal[0])) if normal_span > axis_span else (axis, normal)


def calculate_ceiling_layout(
    walls: Iterable[WallSegment],
    junction_reserve: float = 5.0,
    config: CeilingConfig = DEFAULT_CEILING_CONFIG,
) -> CeilingLayout:
    edges = _restore_graph(walls, junction_reserve)
    rooms = sorted(_bounded_faces(edges), key=lambda room: abs(_signed_area(room)), reverse=True)
    room_edges = [
        {_edge_key(start, end) for start, end in zip(room, (*room[1:], room[0]))}
        for room in rooms
    ]
    edge_rooms: dict[tuple[Point, Point], list[tuple[int, bool]]] = defaultdict(list)
    for room_index, room in enumerate(rooms):
        for start, end in zip(room, (*room[1:], room[0])):
            key = _edge_key(start, end)
            edge_rooms[key].append((room_index, (start, end) == key))

    def support_line(key: tuple[Point, Point]) -> tuple[float, float, float]:
        start, end = key
        length = hypot(end[0] - start[0], end[1] - start[1])
        unit = (end[0] - start[0]) / length, (end[1] - start[1]) / length
        return (
            round(unit[0], 6),
            round(unit[1], 6),
            round(start[0] * -unit[1] + start[1] * unit[0]),
        )

    edge_lines = {key: support_line(key) for key in edge_rooms}
    line_sides = {
        edge_lines[key]: True
        for key, room_indexes in edge_rooms.items()
        if len(room_indexes) > 1
    }

    def owns_edge(room_index: int, key: tuple[Point, Point]) -> bool:
        room_indexes = edge_rooms[key]
        if len(room_indexes) == 1:
            return True
        room_is_left = next(is_left for index, is_left in room_indexes if index == room_index)
        return room_is_left == line_sides[edge_lines[key]]

    def room_region(room_index: int) -> list[Point]:
        keys = room_edges[room_index]
        return _ceiling_boundary(
            rooms[room_index].copy(),
            {key: edges[key].thickness for key in keys},
            {key for key in keys if owns_edge(room_index, key)},
        )

    def score_rooms(room_indexes: list[int]) -> tuple[int, int, float, int, int, float, int]:
        scores = []
        for room_index in room_indexes:
            region = room_region(room_index)
            plan = _layout_region(region, config)
            scores.append(_layout_score(plan.panels, config, region))
        return _sum_scores(scores)

    # ponytail: one greedy pass assigns each complete wall line to the side
    # producing fewer cuts; add global search only if a real plan exposes a local minimum.
    for line in line_sides:
        affected_rooms = sorted(
            {
                room_index
                for key, room_indexes in edge_rooms.items()
                if edge_lines[key] == line
                for room_index, _ in room_indexes
            }
        )
        left_score = score_rooms(affected_rooms)
        line_sides[line] = False
        if left_score <= score_rooms(affected_rooms):
            line_sides[line] = True

    boundaries: list[tuple[Point, ...]] = []
    panels: list[CeilingPanel] = []
    plans: dict[int, _LayoutPlan] = {}
    for room_index in range(len(rooms)):
        region = room_region(room_index)
        inherited = [
            plans[neighbour]
            for neighbour in sorted(
                {
                    neighbour
                    for key in room_edges[room_index]
                    for neighbour, _ in edge_rooms[key]
                }
            )
            if neighbour in plans
        ]
        plan = _layout_region(region, config, inherited)
        plans[room_index] = plan
        boundaries.append(tuple(region))
        panels.extend(plan.panels)
    return CeilingLayout(tuple(boundaries), tuple(panels))


def _layout_region(
    region: list[Point],
    config: CeilingConfig,
    inherited: Iterable[_LayoutPlan] = (),
) -> _LayoutPlan:
    length_axis, width_axis = _axes(region)
    axes = (
        (length_axis, width_axis),
        (width_axis, (-width_axis[1], width_axis[0])),
    )
    candidates = [
        _layout_region_from_grid(
            region, config, candidate_length, candidate_width, length_anchor, width_anchor
        )
        for candidate_length, candidate_width in axes
        for length_anchor in (False, True)
        for width_anchor in (False, True)
    ]
    candidates.extend(
        _layout_region_from_grid(
            region,
            config,
            plan.length_axis,
            plan.width_axis,
            origin=plan.origin,
        )
        for plan in inherited
    )
    return min(candidates, key=lambda plan: _layout_score(plan.panels, config, region))


def _sum_scores(
    scores: Iterable[tuple[int, int, float, int, int, float, int]],
) -> tuple[int, int, float, int, int, float, int]:
    return tuple(sum(values) for values in zip(*scores))  # type: ignore[return-value]


def _layout_score(
    panels: tuple[CeilingPanel, ...],
    config: CeilingConfig,
    region: list[Point],
) -> tuple[int, int, float, int, int, float, int]:
    wasted_area = [
        panel.width * panel.length - abs(_signed_area(panel.vertices))
        for panel in panels
    ]
    panel_area = sum(abs(_signed_area(panel.vertices)) for panel in panels)
    return (
        sum(
            panel.width > config.panel_width + SNAP_TOLERANCE
            or panel.length > config.max_length + SNAP_TOLERANCE
            for panel in panels
        ),
        sum(
            panel.width < config.min_cut_width
            or panel.length < config.min_cut_width
            for panel in panels
        ),
        max(0.0, abs(_signed_area(region)) - panel_area),
        sum(area > SNAP_TOLERANCE for area in wasted_area),
        sum(
            abs(panel.width - config.panel_width) > SNAP_TOLERANCE
            for panel in panels
        ),
        sum(wasted_area)
        + sum(
            max(0.0, config.panel_width - panel.width) * panel.length
            for panel in panels
        ),
        len(panels),
    )


def _layout_region_from_grid(
    region: list[Point],
    config: CeilingConfig,
    length_axis: Point,
    width_axis: Point,
    length_anchor: bool = False,
    width_anchor: bool = False,
    origin: Point | None = None,
) -> _LayoutPlan:

    local_boundary = [
        Vec2(
            point[0] * length_axis[0] + point[1] * length_axis[1],
            point[0] * width_axis[0] + point[1] * width_axis[1],
        )
        for point in region
    ]
    min_x = min(point.x for point in local_boundary)
    max_x = max(point.x for point in local_boundary)
    min_y = min(point.y for point in local_boundary)
    max_y = max(point.y for point in local_boundary)
    if origin is None:
        origin = (
            max_x - config.max_length if length_anchor else min_x,
            max_y - config.panel_width if width_anchor else min_y,
        )
    panels: list[CeilingPanel] = []
    length_pitch = config.max_length + config.joint_gap
    width_pitch = config.panel_width + config.joint_gap
    x = origin[0] + floor((min_x - origin[0]) / length_pitch) * length_pitch
    while x < max_x:
        y = origin[1] + floor((min_y - origin[1]) / width_pitch) * width_pitch
        while y < max_y:
            rectangle = (
                Vec2(x, y),
                Vec2(x + config.max_length, y),
                Vec2(x + config.max_length, y + config.panel_width),
                Vec2(x, y + config.panel_width),
            )
            for piece in ConvexClippingPolygon2d(rectangle).clip_polygon(local_boundary):
                if len(piece) < 3:
                    continue
                if abs(_signed_area([(point.x, point.y) for point in piece])) <= SNAP_TOLERANCE:
                    continue
                piece_min_x = min(point.x for point in piece)
                piece_max_x = max(point.x for point in piece)
                piece_min_y = min(point.y for point in piece)
                piece_max_y = max(point.y for point in piece)
                panels.append(
                    CeilingPanel(
                        tuple(
                            (
                                point.x * length_axis[0] + point.y * width_axis[0],
                                point.x * length_axis[1] + point.y * width_axis[1],
                            )
                            for point in piece
                        ),
                        piece_max_y - piece_min_y,
                        piece_max_x - piece_min_x,
                        length_axis,
                    )
                )
            y += width_pitch
        x += length_pitch
    return _LayoutPlan(tuple(panels), length_axis, width_axis, origin)


def draw_ceiling_layout(
    doc: Drawing,
    layout: CeilingLayout,
    config: CeilingConfig = DEFAULT_CEILING_CONFIG,
) -> None:
    for name, color in CEILING_LAYERS.items():
        if name not in doc.layers:
            doc.layers.add(name, color=color)
    modelspace = doc.modelspace()
    for boundary in layout.boundaries:
        modelspace.add_lwpolyline(
            boundary,
            close=True,
            dxfattribs={"layer": "CEILING_BOUNDARY"},
        )
    for panel in layout.panels:
        rotation = degrees(atan2(panel.length_axis[1], panel.length_axis[0]))
        modelspace.add_lwpolyline(
            panel.vertices,
            close=True,
            dxfattribs={"layer": "CEILING_PANEL"},
        )
        modelspace.add_mtext(
            f"{round(panel.width)}×{round(panel.length)}",
            dxfattribs={"layer": "CEILING_TEXT", "char_height": config.text_height},
        ).set_location(
            _centroid(panel.vertices),
            rotation=rotation,
            attachment_point=MTextEntityAlignment.MIDDLE_CENTER,
        )
