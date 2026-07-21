from __future__ import annotations

from math import atan2, degrees, hypot

Point = tuple[float, float]


def distance(start: Point, end: Point) -> float:
    return hypot(end[0] - start[0], end[1] - start[1])


def point_at(start: Point, end: Point, offset: float, total_length: float) -> Point:
    ratio = offset / total_length
    return start[0] + (end[0] - start[0]) * ratio, start[1] + (end[1] - start[1]) * ratio


def left_normal(start: Point, end: Point) -> Point:
    length = distance(start, end)
    return -(end[1] - start[1]) / length, (end[0] - start[0]) / length


def angle_degrees(start: Point, end: Point) -> float:
    return degrees(atan2(end[1] - start[1], end[0] - start[0]))


def translated(point: Point, vector: Point, amount: float) -> Point:
    return point[0] + vector[0] * amount, point[1] + vector[1] * amount
