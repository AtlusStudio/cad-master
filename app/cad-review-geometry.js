export function rectangleToWall(first, second, id) {
  const minX = Math.min(first.x, second.x)
  const maxX = Math.max(first.x, second.x)
  const minY = Math.min(first.y, second.y)
  const maxY = Math.max(first.y, second.y)
  const width = maxX - minX
  const height = maxY - minY
  if (!width || !height) return null

  return width >= height
    ? {
        id,
        start: [minX, (minY + maxY) / 2],
        end: [maxX, (minY + maxY) / 2],
        thickness: height,
      }
    : {
        id,
        start: [(minX + maxX) / 2, minY],
        end: [(minX + maxX) / 2, maxY],
        thickness: width,
      }
}

export function pointsToOpening(wall, first, second, id, kind) {
  const dx = wall.end[0] - wall.start[0]
  const dy = wall.end[1] - wall.start[1]
  const length = Math.hypot(dx, dy)
  if (!length) return null

  const offset = (point) => Math.min(
    length,
    Math.max(0, ((point.x - wall.start[0]) * dx + (point.y - wall.start[1]) * dy) / length),
  )
  const offsets = [offset(first), offset(second)].sort((a, b) => a - b)
  if (offsets[0] === offsets[1]) return null
  return { id, kind, startOffset: offsets[0], endOffset: offsets[1] }
}

export function matchOpeningToWall(walls, first, second, id, kind) {
  const distanceToWall = (wall, point) => {
    const dx = wall.end[0] - wall.start[0]
    const dy = wall.end[1] - wall.start[1]
    const lengthSquared = dx * dx + dy * dy
    if (!lengthSquared) return Infinity
    const ratio = Math.min(1, Math.max(0, (
      (point.x - wall.start[0]) * dx + (point.y - wall.start[1]) * dy
    ) / lengthSquared))
    return Math.hypot(
      point.x - wall.start[0] - dx * ratio,
      point.y - wall.start[1] - dy * ratio,
    )
  }

  return walls
    .map((wall) => ({
      wall,
      opening: pointsToOpening(wall, first, second, id, kind),
      distance: Math.max(distanceToWall(wall, first), distanceToWall(wall, second)),
    }))
    .filter(({ opening, distance }) => opening && distance <= 150)
    .sort((a, b) => a.distance - b.distance)[0] || null
}
