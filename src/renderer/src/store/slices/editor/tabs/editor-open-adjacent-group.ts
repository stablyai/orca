import type { Tab, TabGroup, TabGroupLayoutNode } from '../../../../../../shared/tab-types'
import { isEditorTabContentType, type EditorTabContentType } from './editor-tab-content-type'

type LayoutRect = { left: number; top: number; right: number; bottom: number }
type LayoutLeaf = { groupId: string; rect: LayoutRect; layoutOrder: number }
type NeighborSide = 'right' | 'left' | 'below' | 'above'
type Neighbor = { side: NeighborSide; position: number }

type Candidate = {
  id: string
  neighbor: Neighbor | null
  hasMatchingFile: boolean
  showsEditor: boolean
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
  const { neighbor, hasMatchingFile, showsEditor, layoutOrder } = candidate
  if (candidate.id === sourceGroupId) {
    return [4, 0, 0, layoutOrder]
  }
  if (!neighbor) {
    return hasMatchingFile ? [1, 0, 0, layoutOrder] : null
  }
  const priority = hasMatchingFile ? 0 : showsEditor ? 2 : 3
  return [priority, SIDE_ORDER[neighbor.side], neighbor.position, layoutOrder]
}

function compareRanks(a: Rank, b: Rank): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || a[3] - b[3]
}

type AdjacentEditorOpenInput = {
  layout: TabGroupLayoutNode
  groups: readonly TabGroup[]
  tabs: readonly Tab[]
  sourceGroupId: string
  /** File identity already resolved by the open path; never re-derived from paths here. */
  fileId: string
  contentType: EditorTabContentType
}

/** Rank live-source destinations: neighboring file copy, any file copy, neighboring editor, any neighbor, source. Null for nonlive source leaves. */
export function pickAdjacentEditorOpenGroupId(input: AdjacentEditorOpenInput): string | null {
  const leaves = projectLayoutLeaves(input.layout)
  const source = leaves.find((leaf) => leaf.groupId === input.sourceGroupId)
  const liveGroups = new Map(input.groups.map((group) => [group.id, group]))
  if (!source || !liveGroups.has(source.groupId)) {
    return null
  }
  const groupsWithFile = new Set<string>()
  const tabsById = new Map<string, Tab>()
  for (const tab of input.tabs) {
    tabsById.set(tab.id, tab)
    if (tab.entityId === input.fileId && tab.contentType === input.contentType) {
      groupsWithFile.add(tab.groupId)
    }
  }
  // Why: the source keeps its conversation visible, so a source-only copy earns no preference.
  groupsWithFile.delete(source.groupId)

  let bestId: string | null = null
  let bestRank: Rank | null = null
  for (const leaf of leaves) {
    const group = liveGroups.get(leaf.groupId)
    if (!group) {
      continue
    }
    const activeTab = group.activeTabId ? tabsById.get(group.activeTabId) : undefined
    const rank = rankCandidate(
      {
        id: leaf.groupId,
        neighbor: leaf.groupId === source.groupId ? null : findNeighbor(source.rect, leaf.rect),
        hasMatchingFile: groupsWithFile.has(leaf.groupId),
        showsEditor: activeTab ? isEditorTabContentType(activeTab.contentType) : false,
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
