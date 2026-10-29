import type { TabGroup, TabGroupLayoutNode } from '../../../shared/tab-types'

type LayoutRect = { left: number; top: number; right: number; bottom: number }
type LayoutLeaf = { groupId: string; rect: LayoutRect; layoutOrder: number }
type NeighborSide = 'right' | 'left' | 'below' | 'above'
type Neighbor = { side: NeighborSide; position: number }

type Candidate = {
  id: string
  neighbor: Neighbor | null
  hasMatchingDestination: boolean
  showsDestinationSurface: boolean
  layoutOrder: number
}
type Rank = readonly [number, number, number, number]

const EPSILON = 1e-9
const SIDE_ORDER = { right: 0, left: 1, below: 2, above: 3 } as const

function clampRatio(ratio: number | undefined): number {
  return typeof ratio === 'number' && Number.isFinite(ratio) && ratio > 0 && ratio < 1 ? ratio : 0.5
}

/** Leaves in stable tree order, each projected into the unit square by its split ratios. */
function projectLayoutLeaves(layout: TabGroupLayoutNode): LayoutLeaf[] {
  const leaves: LayoutLeaf[] = []
  const visit = (node: TabGroupLayoutNode, rect: LayoutRect): void => {
    if (node.type === 'leaf') {
      if (rect.right - rect.left > EPSILON && rect.bottom - rect.top > EPSILON) {
        leaves.push({ groupId: node.groupId, rect, layoutOrder: leaves.length })
      }
      return
    }
    const ratio = clampRatio(node.ratio)
    if (node.direction === 'horizontal') {
      const split = rect.left + (rect.right - rect.left) * ratio
      visit(node.first, { ...rect, right: split })
      visit(node.second, { ...rect, left: split })
    } else {
      const split = rect.top + (rect.bottom - rect.top) * ratio
      visit(node.first, { ...rect, bottom: split })
      visit(node.second, { ...rect, top: split })
    }
  }
  visit(layout, { left: 0, top: 0, right: 1, bottom: 1 })
  return leaves
}

function overlaps(a0: number, a1: number, b0: number, b1: number): boolean {
  return Math.min(a1, b1) - Math.max(a0, b0) > EPSILON
}

function touches(a: number, b: number): boolean {
  return Math.abs(a - b) <= EPSILON
}

/** Shared edge with positive overlap; corner-only contact is not adjacency. */
export function findNeighbor(source: LayoutRect, target: LayoutRect): Neighbor | null {
  const verticalOverlap = overlaps(source.top, source.bottom, target.top, target.bottom)
  const horizontalOverlap = overlaps(source.left, source.right, target.left, target.right)
  if (verticalOverlap && touches(source.right, target.left)) {
    return { side: 'right', position: target.top }
  }
  if (verticalOverlap && touches(source.left, target.right)) {
    return { side: 'left', position: target.top }
  }
  if (horizontalOverlap && touches(source.bottom, target.top)) {
    return { side: 'below', position: target.left }
  }
  if (horizontalOverlap && touches(source.top, target.bottom)) {
    return { side: 'above', position: target.left }
  }
  return null
}

function rankCandidate(candidate: Candidate, sourceGroupId: string): Rank | null {
  const { neighbor, hasMatchingDestination, showsDestinationSurface, layoutOrder } = candidate
  if (candidate.id === sourceGroupId) {
    return [4, 0, 0, layoutOrder]
  }
  if (!neighbor) {
    return hasMatchingDestination ? [1, 0, 0, layoutOrder] : null
  }
  const priority = hasMatchingDestination ? 0 : showsDestinationSurface ? 2 : 3
  return [priority, SIDE_ORDER[neighbor.side], neighbor.position, layoutOrder]
}

function compareRanks(a: Rank, b: Rank): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || a[3] - b[3]
}

export function pickAdjacentLinkOpenGroupId(input: {
  layout: TabGroupLayoutNode
  groups: readonly TabGroup[]
  sourceGroupId: string
  facts: ReadonlyMap<string, { hasMatchingDestination: boolean; showsDestinationSurface: boolean }>
}): string | null {
  const leaves = projectLayoutLeaves(input.layout)
  const liveGroups = new Set(input.groups.map((group) => group.id))
  const source = leaves.find((leaf) => leaf.groupId === input.sourceGroupId)
  if (!source || !liveGroups.has(source.groupId)) {
    return null
  }
  let bestId: string | null = null
  let bestRank: Rank | null = null
  for (const leaf of leaves) {
    if (!liveGroups.has(leaf.groupId)) {
      continue
    }
    const facts = input.facts.get(leaf.groupId)
    const rank = rankCandidate(
      {
        id: leaf.groupId,
        neighbor: leaf.groupId === source.groupId ? null : findNeighbor(source.rect, leaf.rect),
        hasMatchingDestination: facts?.hasMatchingDestination ?? false,
        showsDestinationSurface: facts?.showsDestinationSurface ?? false,
        layoutOrder: leaf.layoutOrder
      },
      source.groupId
    )
    if (rank && (!bestRank || compareRanks(rank, bestRank) < 0)) {
      bestRank = rank
      bestId = leaf.groupId
    }
  }
  return bestId
}
