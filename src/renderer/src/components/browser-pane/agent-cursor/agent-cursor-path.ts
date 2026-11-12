// Curved flight paths for the agent cursor. Long moves leave and land along the
// cursor's own pointing direction, so it arrives tip-first like a hand-moved mouse.

export type CursorPoint = { x: number; y: number }
export type CursorBounds = { width: number; height: number }

type CubicSegment = { c1: CursorPoint; c2: CursorPoint; end: CursorPoint }

export type CursorPath = {
  start: CursorPoint
  segments: CubicSegment[]
  arc: boolean
}

type PathMeasure = {
  length: number
  bendEnergy: number
  maxTurn: number
  totalTurn: number
  inBounds: boolean
}

/** Rest heading of the arrow glyph, in degrees clockwise from straight up. */
export const CURSOR_REST_HEADING_DEG = -44

const BOUNDS_MARGIN_PX = 20
const START_HANDLE = 0.42
const END_HANDLE = 0.15
const ARC_SIZE = 0.277
const ARC_FLOW = 0.578
const ARC_DISTANCE_SCALES = [0.55, 0.8, 1.05]
const ARC_HANDLE_SCALES = [0.65, 1, 1.35]
const SAMPLES_PER_SEGMENT = 24

export const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value))

const distance = (a: CursorPoint, b: CursorPoint): number => Math.hypot(b.x - a.x, b.y - a.y)

function unit(v: CursorPoint): CursorPoint {
  const length = Math.hypot(v.x, v.y)
  return length < 0.001 ? { x: 1, y: 0 } : { x: v.x / length, y: v.y / length }
}

function headingVector(degrees: number): CursorPoint {
  const radians = (degrees * Math.PI) / 180
  return { x: Math.sin(radians), y: -Math.cos(radians) }
}

/** Degrees clockwise from straight up for a direction vector. */
function headingOf(direction: CursorPoint): number {
  if (Math.hypot(direction.x, direction.y) < 0.001) {
    return CURSOR_REST_HEADING_DEG
  }
  return (Math.atan2(direction.y, direction.x) * 180) / Math.PI + 90
}

/** Shortens a handle so its control point stays inside the page. */
function handleInside(
  from: CursorPoint,
  direction: CursorPoint,
  length: number,
  bounds: CursorBounds
): CursorPoint {
  let reach = length
  if (direction.x < 0) {
    reach = Math.min(reach, from.x / -direction.x)
  } else if (direction.x > 0) {
    reach = Math.min(reach, (bounds.width - from.x) / direction.x)
  }
  if (direction.y < 0) {
    reach = Math.min(reach, from.y / -direction.y)
  } else if (direction.y > 0) {
    reach = Math.min(reach, (bounds.height - from.y) / direction.y)
  }
  reach = Math.max(0, reach)
  return { x: from.x + direction.x * reach, y: from.y + direction.y * reach }
}

function cubicPoint(p0: CursorPoint, { c1, c2, end }: CubicSegment, t: number): CursorPoint {
  const u = 1 - t
  const a = u * u * u
  const b = 3 * u * u * t
  const c = 3 * u * t * t
  const d = t * t * t
  return {
    x: p0.x * a + c1.x * b + c2.x * c + end.x * d,
    y: p0.y * a + c1.y * b + c2.y * c + end.y * d
  }
}

function cubicTangent(p0: CursorPoint, { c1, c2, end }: CubicSegment, t: number): CursorPoint {
  const u = 1 - t
  return {
    x: 3 * u * u * (c1.x - p0.x) + 6 * u * t * (c2.x - c1.x) + 3 * t * t * (end.x - c2.x),
    y: 3 * u * u * (c1.y - p0.y) + 6 * u * t * (c2.y - c1.y) + 3 * t * t * (end.y - c2.y)
  }
}

function wrapRadians(angle: number): number {
  let wrapped = angle
  while (wrapped > Math.PI) {
    wrapped -= Math.PI * 2
  }
  while (wrapped < -Math.PI) {
    wrapped += Math.PI * 2
  }
  return wrapped
}

function isInside(point: CursorPoint, bounds: CursorBounds): boolean {
  return (
    point.x >= BOUNDS_MARGIN_PX &&
    point.x <= bounds.width - BOUNDS_MARGIN_PX &&
    point.y >= BOUNDS_MARGIN_PX &&
    point.y <= bounds.height - BOUNDS_MARGIN_PX
  )
}

function measurePath(path: CursorPath, bounds: CursorBounds): PathMeasure {
  const measure: PathMeasure = {
    length: 0,
    bendEnergy: 0,
    maxTurn: 0,
    totalTurn: 0,
    inBounds: isInside(path.start, bounds)
  }
  let segmentStart = path.start
  let previous = path.start
  let previousAngle: number | null = null
  for (const segment of path.segments) {
    for (let step = 1; step <= SAMPLES_PER_SEGMENT; step += 1) {
      const point = cubicPoint(segmentStart, segment, step / SAMPLES_PER_SEGMENT)
      measure.length += distance(previous, point)
      measure.inBounds &&= isInside(point, bounds)
      if (distance(previous, point) > 0.01) {
        const angle = Math.atan2(point.y - previous.y, point.x - previous.x)
        if (previousAngle !== null) {
          const turn = wrapRadians(angle - previousAngle)
          measure.bendEnergy += turn * turn
          measure.maxTurn = Math.max(measure.maxTurn, Math.abs(turn))
          measure.totalTurn += Math.abs(turn)
        }
        previousAngle = angle
      }
      previous = point
    }
    segmentStart = segment.end
  }
  return measure
}

/** 0 when travelling along the arrow's pointing direction, 1 when straight against it. */
function againstPointing(path: CursorPath): number {
  const end = path.segments.at(-1)?.end ?? path.start
  const travel = unit({ x: end.x - path.start.x, y: end.y - path.start.y })
  const pointing = headingVector(CURSOR_REST_HEADING_DEG)
  return clamp((-(travel.x * pointing.x + travel.y * pointing.y) - 0.08) / 0.92, 0, 1)
}

function scorePath(path: CursorPath, measure: PathMeasure): number {
  const chord = Math.max(1, distance(path.start, path.segments.at(-1)?.end ?? path.start))
  const detour = Math.max(0, measure.length / chord - 1)
  return (
    measure.length +
    detour * 320 +
    measure.bendEnergy * 140 +
    measure.maxTurn * 180 +
    measure.totalTurn * 18 +
    againstPointing(path) * 90 +
    (path.arc ? 45 : 0)
  )
}

function candidatePaths(start: CursorPoint, end: CursorPoint, bounds: CursorBounds): CursorPath[] {
  const chord = distance(start, end)
  const pointing = headingVector(CURSOR_REST_HEADING_DEG)
  const backward = { x: -pointing.x, y: -pointing.y }
  const startReach = clamp(chord * START_HANDLE, 48, Math.min(640, chord * 0.9))
  const endReach = clamp(chord * END_HANDLE, 48, Math.min(640, chord * 0.9))
  const direct = (scale: number): CursorPath => ({
    start,
    arc: false,
    segments: [
      {
        c1: handleInside(start, pointing, startReach * scale, bounds),
        c2: handleInside(end, backward, endReach * scale, bounds),
        end
      }
    ]
  })
  const candidates = [direct(1), direct(0.65)]

  const travel = unit({ x: end.x - start.x, y: end.y - start.y })
  const normal = { x: -travel.y, y: travel.x }
  const naturalSide = normal.x * pointing.x + normal.y * pointing.y >= 0 ? 1 : -1
  const midpoint = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 }
  const arcDistance = clamp(chord * ARC_SIZE, 50, 520)
  const arcHandle = clamp(chord * ARC_FLOW, 38, 440)
  const startControl = handleInside(start, pointing, startReach, bounds)
  const endControl = handleInside(end, backward, endReach, bounds)
  for (const side of [naturalSide, -naturalSide]) {
    for (const distanceScale of ARC_DISTANCE_SCALES) {
      for (const handleScale of ARC_HANDLE_SCALES) {
        const bulge = {
          x:
            midpoint.x +
            normal.x * side * arcDistance * distanceScale +
            pointing.x * startReach * 0.16,
          y:
            midpoint.y +
            normal.y * side * arcDistance * distanceScale +
            pointing.y * startReach * 0.16
        }
        const reach = arcHandle * handleScale
        candidates.push({
          start,
          arc: true,
          segments: [
            {
              c1: startControl,
              c2: { x: bulge.x - travel.x * reach, y: bulge.y - travel.y * reach },
              end: bulge
            },
            {
              c1: { x: bulge.x + travel.x * reach, y: bulge.y + travel.y * reach },
              c2: endControl,
              end
            }
          ]
        })
      }
    }
  }
  return candidates
}

type PlannedCursorPath = {
  path: CursorPath
  /** Spring response, in seconds, for travelling the whole path. */
  response: number
}

/** Picks the calmest curve that stays inside the page, and how long to take on it. */
export function planCursorPath(
  start: CursorPoint,
  end: CursorPoint,
  bounds: CursorBounds
): PlannedCursorPath {
  const scored = candidatePaths(start, end, bounds).map((path) => {
    const measure = measurePath(path, bounds)
    return { path, measure, score: scorePath(path, measure) }
  })
  const inside = scored.filter((candidate) => candidate.measure.inBounds)
  const chosen = (inside.length > 0 ? inside : scored).reduce((best, candidate) =>
    candidate.score < best.score ? candidate : best
  )
  return { path: chosen.path, response: pathResponse(chosen.path, chosen.measure) }
}

function pathResponse(path: CursorPath, measure: PathMeasure): number {
  const chord = Math.max(1, distance(path.start, path.segments.at(-1)?.end ?? path.start))
  const lengthWeight = clamp((measure.length - 180) / 760, 0, 1)
  const curviness = clamp(
    clamp(Math.max(0, measure.length / chord - 1) / 0.55, 0, 1) * 0.42 +
      clamp(measure.totalTurn / (Math.PI * 1.4), 0, 1) * 0.38 +
      clamp(measure.bendEnergy / 1.25, 0, 1) * 0.2,
    0,
    1
  )
  const base =
    0.42 +
    lengthWeight * 0.22 +
    curviness * 0.12 +
    againstPointing(path) * 0.28 +
    (path.arc ? 0.04 : 0)
  return clamp(base * 0.7 * (path.arc ? 0.9 : 1), 0.12, 2.2)
}

/** Point and travel heading at progress 0..1 along the path. */
export function samplePath(
  path: CursorPath,
  progress: number
): { point: CursorPoint; heading: number } {
  const clamped = clamp(progress, 0, 1)
  const scaled = clamped === 1 ? path.segments.length - 1 : clamped * path.segments.length
  const index = Math.floor(scaled)
  const segment = path.segments[index]
  const segmentStart = index === 0 ? path.start : path.segments[index - 1].end
  const t = clamped === 1 ? 1 : scaled - index
  return {
    point: cubicPoint(segmentStart, segment, t),
    heading: headingOf(cubicTangent(segmentStart, segment, t))
  }
}

/** How far along the straight line from start to end a point has travelled, 0..1. */
export function projectedProgress(
  point: CursorPoint,
  start: CursorPoint,
  end: CursorPoint
): number {
  const span = { x: end.x - start.x, y: end.y - start.y }
  const lengthSquared = span.x * span.x + span.y * span.y
  if (lengthSquared < 0.001) {
    return 1
  }
  return clamp(((point.x - start.x) * span.x + (point.y - start.y) * span.y) / lengthSquared, 0, 1)
}
