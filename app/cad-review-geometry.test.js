import assert from "node:assert/strict"

import {
  matchOpeningToWall,
  pointsToOpening,
  rectangleToWall,
} from "./cad-review-geometry.js"

const horizontal = rectangleToWall({ x: 0, y: 0 }, { x: 3000, y: 100 }, "MW0001")
assert.deepEqual(horizontal, {
  id: "MW0001",
  start: [0, 50],
  end: [3000, 50],
  thickness: 100,
})

const vertical = rectangleToWall({ x: 100, y: 2000 }, { x: 0, y: 0 }, "MW0002")
assert.deepEqual(vertical, {
  id: "MW0002",
  start: [50, 0],
  end: [50, 2000],
  thickness: 100,
})

assert.deepEqual(
  pointsToOpening(horizontal, { x: 1700, y: 0 }, { x: 800, y: 100 }, "MO0001", "door"),
  { id: "MO0001", kind: "door", startOffset: 800, endOffset: 1700 },
)

assert.equal(
  matchOpeningToWall(
    [horizontal, vertical],
    { x: 800, y: 60 },
    { x: 1700, y: 60 },
    "MO0002",
    "door",
  ).wall.id,
  "MW0001",
)

assert.equal(
  matchOpeningToWall(
    [horizontal, vertical],
    { x: 40, y: 500 },
    { x: 40, y: 1200 },
    "MO0003",
    "window",
  ).wall.id,
  "MW0002",
)

const adjacent = { id: "W0003", start: [0, 300], end: [3000, 300], thickness: 100 }
assert.equal(
  matchOpeningToWall(
    [horizontal, adjacent],
    { x: 800, y: 280 },
    { x: 1700, y: 280 },
    "MO0004",
    "door",
  ).wall.id,
  "W0003",
)

assert.equal(
  matchOpeningToWall(
    [horizontal],
    { x: 800, y: 201 },
    { x: 1700, y: 201 },
    "MO0005",
    "door",
  ),
  null,
)
