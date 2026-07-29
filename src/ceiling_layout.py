from __future__ import annotations

from collections import Counter, defaultdict
from dataclasses import dataclass
from math import atan2, ceil, degrees, hypot
from typing import Iterable

from ezdxf.document import Drawing
from ezdxf.enums import MTextEntityAlignment
from ezdxf.math import Vec2
from ezdxf.math.clipping import ConcaveClippingPolygon2d

from .geometry import Point
from .wall_detector import WallSegment

CEILING_PANEL_WIDTH = 1180.0
CEILING_MAX_LENGTH = 3000.0
CEILING_JOINT_GAP = 3.0
CEILING_MIN_CUT = 150.0
CEILING_LAYERS = {
    "CEILING_BOUNDARY": 3,
    "CEILING_PANEL": 2,
    "CEILING_TEXT": 4,
}
SNAP_TOLERANCE = 1.0


@dataclass(frozen=True)
class CeilingPanel:
    vertices: tuple[Point, ...]
    width: float
    length: float


@dataclass(frozen=True)
class CeilingLayout:
    boundary: tuple[Point, ...]
    panels: tuple[CeilingPanel, ...]
    length_axis: Point


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


def _segments(span: float, maximum: float) -> list[float]:
    count = max(1, ceil((span + CEILING_JOINT_GAP) / (maximum + CEILING_JOINT_GAP)))
    usable = span - CEILING_JOINT_GAP * (count - 1)
    last = usable - maximum * (count - 1)
    if count == 1 or last >= CEILING_MIN_CUT:
        return [maximum] * (count - 1) + [last]
    edge = (usable - maximum * (count - 2)) / 2.0
    return [edge, *([maximum] * (count - 2)), edge]


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
    if abs(denominator) < 1e-9:
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
            if intersection is None:
                continue
            first_position, second_position = intersection
            first_extension = (
                first.thickness / 2.0 + junction_reserve + SNAP_TOLERANCE
            ) / first.length
            second_extension = (
                second.thickness / 2.0 + junction_reserve + SNAP_TOLERANCE
            ) / second.length
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


def _outer_boundary(
    faces: list[list[Point]],
    edges: dict[tuple[Point, Point], _Edge],
) -> tuple[list[Point], dict[tuple[Point, Point], float]]:
    edge_counts: Counter[tuple[Point, Point]] = Counter()
    for face in faces:
        edge_counts.update(
            _edge_key(start, end)
            for start, end in zip(face, (*face[1:], face[0]))
        )
    boundary_keys = {key for key, count in edge_counts.items() if count == 1}
    boundary_edges = {key: edges[key] for key in boundary_keys}
    rings = _bounded_faces(boundary_edges)
    if not rings:
        raise ValueError("无法从最外层墙面形成闭合吊顶区域")
    ring = max(rings, key=lambda vertices: abs(_signed_area(vertices)))
    thicknesses = {key: boundary_edges[key].thickness for key in boundary_keys}
    return ring, thicknesses


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


def _inner_boundary(
    boundary: list[Point],
    thicknesses: dict[tuple[Point, Point], float],
) -> list[Point]:
    if _signed_area(boundary) < 0:
        boundary.reverse()
    offset_lines: list[tuple[Point, Point]] = []
    for start, end in zip(boundary, (*boundary[1:], boundary[0])):
        length = hypot(end[0] - start[0], end[1] - start[1])
        normal = -(end[1] - start[1]) / length, (end[0] - start[0]) / length
        offset = thicknesses[_edge_key(start, end)] / 2.0
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
        raise ValueError("最外层墙面内偏移后没有有效吊顶区域")
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
) -> CeilingLayout:
    edges = _restore_graph(walls, junction_reserve)
    boundary, thicknesses = _outer_boundary(_bounded_faces(edges), edges)
    inner = _inner_boundary(boundary, thicknesses)
    length_axis, width_axis = _axes(inner)

    local_boundary = [
        Vec2(
            point[0] * length_axis[0] + point[1] * length_axis[1],
            point[0] * width_axis[0] + point[1] * width_axis[1],
        )
        for point in inner
    ]
    clipper = ConcaveClippingPolygon2d(local_boundary)
    min_x = min(point.x for point in local_boundary)
    max_x = max(point.x for point in local_boundary)
    min_y = min(point.y for point in local_boundary)
    max_y = max(point.y for point in local_boundary)
    panels: list[CeilingPanel] = []
    x = min_x
    for panel_length in _segments(max_x - min_x, CEILING_MAX_LENGTH):
        y = min_y
        for panel_width in _segments(max_y - min_y, CEILING_PANEL_WIDTH):
            rectangle = (
                Vec2(x, y),
                Vec2(x + panel_length, y),
                Vec2(x + panel_length, y + panel_width),
                Vec2(x, y + panel_width),
            )
            for piece in clipper.clip_polygon(rectangle):
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
                    )
                )
            y += panel_width + CEILING_JOINT_GAP
        x += panel_length + CEILING_JOINT_GAP
    return CeilingLayout(tuple(inner), tuple(panels), length_axis)


def draw_ceiling_layout(doc: Drawing, layout: CeilingLayout) -> None:
    for name, color in CEILING_LAYERS.items():
        if name not in doc.layers:
            doc.layers.add(name, color=color)
    modelspace = doc.modelspace()
    modelspace.add_lwpolyline(
        layout.boundary,
        close=True,
        dxfattribs={"layer": "CEILING_BOUNDARY"},
    )
    rotation = degrees(atan2(layout.length_axis[1], layout.length_axis[0]))
    for panel in layout.panels:
        modelspace.add_lwpolyline(
            panel.vertices,
            close=True,
            dxfattribs={"layer": "CEILING_PANEL"},
        )
        modelspace.add_mtext(
            f"{round(panel.width)}×{round(panel.length)}",
            dxfattribs={"layer": "CEILING_TEXT", "char_height": 125.0},
        ).set_location(
            _centroid(panel.vertices),
            rotation=rotation,
            attachment_point=MTextEntityAlignment.MIDDLE_CENTER,
        )
