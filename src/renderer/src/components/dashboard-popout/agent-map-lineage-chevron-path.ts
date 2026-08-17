export type AgentMapLineagePoint = {
  x: number
  y: number
}

type AgentMapLineageNode = AgentMapLineagePoint & {
  radius: number
}

type LineageSegment = {
  start: AgentMapLineagePoint
  unitX: number
  unitY: number
  length: number
}

const CHEVRON_SPACING = 8
const CHEVRON_DEPTH = 3.5
const CHEVRON_HALF_WIDTH = 2.25
const MAX_CHEVRONS_PER_PATH = 256

function svgNumber(value: number): number {
  return Math.round(value * 1_000) / 1_000
}

export function agentMapLineageChevronPath(points: AgentMapLineagePoint[]): string {
  const segments: LineageSegment[] = []
  let totalLength = 0
  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1]
    const end = points[index]
    const dx = end.x - start.x
    const dy = end.y - start.y
    const length = Math.hypot(dx, dy)
    if (length === 0) {
      continue
    }
    segments.push({ start, unitX: dx / length, unitY: dy / length, length })
    totalLength += length
  }
  if (segments.length === 0 || totalLength < CHEVRON_DEPTH * 2) {
    return points[0] ? `M ${svgNumber(points[0].x)} ${svgNumber(points[0].y)}` : ''
  }

  const chevronCount = Math.min(
    MAX_CHEVRONS_PER_PATH,
    Math.max(1, Math.floor(totalLength / CHEVRON_SPACING))
  )
  // Fixed pitch, centered run: spacing must read identically on a short link and a long
  // one. Dividing the length by the count instead stretched the gaps as nodes moved apart.
  const firstDistance = (totalLength - (chevronCount - 1) * CHEVRON_SPACING) / 2
  const commands: string[] = []
  let segmentIndex = 0
  let segmentStartDistance = 0
  for (let index = 0; index < chevronCount; index += 1) {
    const distance = firstDistance + index * CHEVRON_SPACING
    while (
      segmentIndex < segments.length - 1 &&
      distance > segmentStartDistance + segments[segmentIndex].length
    ) {
      segmentStartDistance += segments[segmentIndex].length
      segmentIndex += 1
    }
    const segment = segments[segmentIndex]
    const offset = distance - segmentStartDistance
    const tipX = segment.start.x + segment.unitX * offset
    const tipY = segment.start.y + segment.unitY * offset
    const backX = tipX - segment.unitX * CHEVRON_DEPTH
    const backY = tipY - segment.unitY * CHEVRON_DEPTH
    const perpendicularX = -segment.unitY * CHEVRON_HALF_WIDTH
    const perpendicularY = segment.unitX * CHEVRON_HALF_WIDTH
    commands.push(
      `M ${svgNumber(backX + perpendicularX)} ${svgNumber(backY + perpendicularY)} L ${svgNumber(tipX)} ${svgNumber(tipY)} L ${svgNumber(backX - perpendicularX)} ${svgNumber(backY - perpendicularY)}`
    )
  }
  return commands.join(' ')
}

function buildDirectLineageChevronPath(
  parent: AgentMapLineageNode,
  child: AgentMapLineageNode
): string {
  const dx = child.x - parent.x
  const dy = child.y - parent.y
  const distance = Math.hypot(dx, dy)
  if (distance <= parent.radius + child.radius) {
    return agentMapLineageChevronPath([parent])
  }
  const unitX = dx / distance
  const unitY = dy / distance
  return agentMapLineageChevronPath([
    { x: parent.x + unitX * parent.radius, y: parent.y + unitY * parent.radius },
    { x: child.x - unitX * child.radius, y: child.y - unitY * child.radius }
  ])
}

// Keyed on world coordinates, which a zoom gesture never changes — so the scene's
// per-frame rerender reuses every path instead of rebuilding kilobytes of `d` at
// 60fps. Only enter/exit motion, which really does move nodes, misses. LRU-bounded
// because a removed agent's key is never revisited.
const MAX_CACHED_LINEAGE_PATHS = 512
const lineagePathCache = new Map<string, string>()

export function agentMapDirectLineageChevronPath(
  parent: AgentMapLineageNode,
  child: AgentMapLineageNode
): string {
  const key = `${parent.x},${parent.y},${parent.radius},${child.x},${child.y},${child.radius}`
  const cached = lineagePathCache.get(key)
  if (cached !== undefined) {
    lineagePathCache.delete(key)
    lineagePathCache.set(key, cached)
    return cached
  }
  const path = buildDirectLineageChevronPath(parent, child)
  lineagePathCache.set(key, path)
  while (lineagePathCache.size > MAX_CACHED_LINEAGE_PATHS) {
    const oldest = lineagePathCache.keys().next().value
    if (oldest === undefined) {
      break
    }
    lineagePathCache.delete(oldest)
  }
  return path
}
