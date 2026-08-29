import {
  addAgentMapPackingCircle,
  agentMapPackingCircleOverlaps,
  AGENT_MAP_PACKING_SCORE_TOLERANCE,
  AGENT_MAP_WORKTREE_GAP,
  type AgentMapPackableCircle,
  type AgentMapPackingSpatialIndex
} from './agent-map-packing-spatial-index'

export { AGENT_MAP_WORKTREE_GAP } from './agent-map-packing-spatial-index'

const PACKING_ANGLE_STEPS = 72
const MAX_PACKING_CANDIDATE_ANCHORS = 128
const MAX_DIRECT_OVERLAP_WORKTREES = 4
const LARGE_PACKING_THRESHOLD = 256
const VERY_LARGE_PACKING_THRESHOLD = 512
const SCORE_TOLERANCE = AGENT_MAP_PACKING_SCORE_TOLERANCE
const CENTER_DIRECTIONS = [
  [-1, -1],
  [0, -1],
  [1, -1],
  [-1, 0],
  [1, 0],
  [-1, 1],
  [0, 1],
  [1, 1]
] as const

type PackableWorktree = AgentMapPackableCircle

type PackingCandidate = {
  x: number
  y: number
  enclosingRadius: number
  distanceFromCenter: number
  neighborDistance?: number
}

type PackingSearchBudget = {
  angleSteps: number
  candidateAnchors: number
}

function compareStable(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function hashFraction(value: string): number {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0) / 0xffffffff
}

function placedWorktreesOverlap(
  candidate: Pick<PackableWorktree, 'x' | 'y' | 'radius'>,
  placed: PackableWorktree[]
): boolean {
  return placed.some(
    (worktree) =>
      Math.hypot(candidate.x - worktree.x, candidate.y - worktree.y) <
      candidate.radius + worktree.radius + AGENT_MAP_WORKTREE_GAP - SCORE_TOLERANCE
  )
}

function comparePackingScores(
  a: PackingCandidate,
  b: PackingCandidate,
  placed: PackableWorktree[]
): number {
  for (const key of ['enclosingRadius', 'distanceFromCenter'] as const) {
    if (Math.abs(a[key] - b[key]) > SCORE_TOLERANCE) {
      return a[key] - b[key]
    }
  }
  a.neighborDistance ??= placed.reduce(
    (sum, other) => sum + Math.hypot(a.x - other.x, a.y - other.y),
    0
  )
  b.neighborDistance ??= placed.reduce(
    (sum, other) => sum + Math.hypot(b.x - other.x, b.y - other.y),
    0
  )
  return Math.abs(a.neighborDistance - b.neighborDistance) > SCORE_TOLERANCE
    ? a.neighborDistance - b.neighborDistance
    : 0
}

function compareBoundaryAnchors(a: PackableWorktree, b: PackableWorktree): number {
  return (
    Math.hypot(b.x, b.y) + b.radius - (Math.hypot(a.x, a.y) + a.radius) || compareStable(a.id, b.id)
  )
}

function addBoundaryAnchor(
  boundaryAnchors: PackableWorktree[],
  worktree: PackableWorktree,
  maxAnchors: number
): void {
  let low = 0
  let high = boundaryAnchors.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (compareBoundaryAnchors(worktree, boundaryAnchors[middle]) < 0) {
      high = middle
    } else {
      low = middle + 1
    }
  }
  boundaryAnchors.splice(low, 0, worktree)
  if (boundaryAnchors.length > maxAnchors) {
    boundaryAnchors.pop()
  }
}

function placePackedWorktree(
  worktree: PackableWorktree,
  placed: PackableWorktree[],
  boundaryAnchors: PackableWorktree[],
  spatialIndex: AgentMapPackingSpatialIndex | null,
  currentRadius: number,
  searchBudget: PackingSearchBudget
): void {
  let best: PackingCandidate | undefined

  const anchors = placed.length <= searchBudget.candidateAnchors ? placed : boundaryAnchors
  const scoreNeighbors =
    searchBudget.candidateAnchors === MAX_PACKING_CANDIDATE_ANCHORS ? placed : anchors
  for (const anchor of anchors) {
    const orbit = anchor.radius + worktree.radius + AGENT_MAP_WORKTREE_GAP
    const angleOffset = hashFraction(`${worktree.id}:${anchor.id}`) * Math.PI * 2
    for (let step = 0; step < searchBudget.angleSteps; step += 1) {
      const angle = angleOffset + (step / searchBudget.angleSteps) * Math.PI * 2
      const x = anchor.x + Math.cos(angle) * orbit
      const y = anchor.y + Math.sin(angle) * orbit
      const overlapCandidate = { x, y, radius: worktree.radius }
      if (
        spatialIndex
          ? agentMapPackingCircleOverlaps(overlapCandidate, spatialIndex)
          : placedWorktreesOverlap(overlapCandidate, placed)
      ) {
        continue
      }
      const distanceFromCenter = Math.hypot(x, y)
      const candidate = {
        x,
        y,
        enclosingRadius: Math.max(currentRadius, distanceFromCenter + worktree.radius),
        distanceFromCenter
      }
      if (!best || comparePackingScores(candidate, best, scoreNeighbors) < 0) {
        best = candidate
      }
    }
  }

  if (best) {
    worktree.x = best.x
    worktree.y = best.y
    return
  }
  let fallbackX = Number.NEGATIVE_INFINITY
  for (const candidate of placed) {
    fallbackX = Math.max(fallbackX, candidate.x + candidate.radius)
  }
  worktree.x = fallbackX + worktree.radius + AGENT_MAP_WORKTREE_GAP
  worktree.y = 0
}

function enclosingRadius(worktrees: PackableWorktree[], x: number, y: number): number {
  let radius = 0
  for (const worktree of worktrees) {
    radius = Math.max(radius, Math.hypot(worktree.x - x, worktree.y - y) + worktree.radius)
  }
  return radius
}

function packingSearchBudget(count: number): PackingSearchBudget {
  if (count > VERY_LARGE_PACKING_THRESHOLD) {
    return { angleSteps: 16, candidateAnchors: 12 }
  }
  if (count > LARGE_PACKING_THRESHOLD) {
    return { angleSteps: 24, candidateAnchors: 64 }
  }
  return {
    angleSteps: PACKING_ANGLE_STEPS,
    candidateAnchors: MAX_PACKING_CANDIDATE_ANCHORS
  }
}

function findEnclosingCenter(
  worktrees: PackableWorktree[],
  bounds: { left: number; right: number; top: number; bottom: number }
): { x: number; y: number } {
  let x = (bounds.left + bounds.right) / 2
  let y = (bounds.top + bounds.bottom) / 2
  let radius = enclosingRadius(worktrees, x, y)
  let step = Math.max(bounds.right - bounds.left, bounds.bottom - bounds.top) / 4

  while (step > SCORE_TOLERANCE) {
    let improved = false
    for (const [dx, dy] of CENTER_DIRECTIONS) {
      const candidateX = x + dx * step
      const candidateY = y + dy * step
      const candidateRadius = enclosingRadius(worktrees, candidateX, candidateY)
      if (candidateRadius < radius - SCORE_TOLERANCE) {
        x = candidateX
        y = candidateY
        radius = candidateRadius
        improved = true
      }
    }
    if (!improved) {
      step /= 2
    }
  }
  return { x, y }
}

export function packAgentMapWorktrees<T extends PackableWorktree>(worktrees: T[]): T[] {
  const packed = [...worktrees].sort((a, b) => b.radius - a.radius || compareStable(a.id, b.id))
  const placed: PackableWorktree[] = []
  const boundaryAnchors: PackableWorktree[] = []
  const searchBudget = packingSearchBudget(packed.length)
  const spatialIndex: AgentMapPackingSpatialIndex | null =
    packed.length > MAX_DIRECT_OVERLAP_WORKTREES ? new Map() : null
  let currentRadius = 0
  for (const worktree of packed) {
    if (placed.length > 0) {
      placePackedWorktree(
        worktree,
        placed,
        boundaryAnchors,
        spatialIndex,
        currentRadius,
        searchBudget
      )
    }
    placed.push(worktree)
    addBoundaryAnchor(boundaryAnchors, worktree, searchBudget.candidateAnchors)
    if (spatialIndex) {
      addAgentMapPackingCircle(spatialIndex, worktree)
    }
    currentRadius = Math.max(currentRadius, Math.hypot(worktree.x, worktree.y) + worktree.radius)
  }
  if (packed.length === 0) {
    return packed
  }
  let left = Number.POSITIVE_INFINITY
  let right = Number.NEGATIVE_INFINITY
  let top = Number.POSITIVE_INFINITY
  let bottom = Number.NEGATIVE_INFINITY
  for (const worktree of packed) {
    left = Math.min(left, worktree.x - worktree.radius)
    right = Math.max(right, worktree.x + worktree.radius)
    top = Math.min(top, worktree.y - worktree.radius)
    bottom = Math.max(bottom, worktree.y + worktree.radius)
  }
  const center = findEnclosingCenter(packed, { left, right, top, bottom })
  for (const worktree of packed) {
    worktree.x -= center.x
    worktree.y -= center.y
  }
  return packed.sort((a, b) => compareStable(a.id, b.id))
}
