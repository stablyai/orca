import type { WorktreeItemRow } from './renderable-rows'

export const LINEAGE_SIBLING_GAP = 4
export const ESTIMATED_LINEAGE_CARD_HEIGHT = 96
export const LINEAGE_VIRTUAL_OVERSCAN = 10

export type LineageVirtualNode = {
  row: WorktreeItemRow
  parentIndex: number | null
  children: number[]
  endIndex: number
  followingSibling: boolean
}

export type LineageVirtualTree = {
  nodes: LineageVirtualNode[]
  roots: number[]
  indexByRowKey: ReadonlyMap<string, number>
  indexesByWorktreeId: ReadonlyMap<string, readonly number[]>
}

// Preorder subtree boundaries avoid rescanning and copying each descendant suffix.
export function buildLineageVirtualTree(rows: readonly WorktreeItemRow[]): LineageVirtualTree {
  const nodes: LineageVirtualNode[] = []
  const roots: number[] = []
  const stack: number[] = []
  const indexByRowKey = new Map<string, number>()
  const indexesByWorktreeId = new Map<string, number[]>()
  for (const [index, row] of rows.entries()) {
    while (stack.length > 0 && nodes[stack.at(-1)!]!.row.depth >= row.depth) {
      nodes[stack.pop()!]!.endIndex = index
    }
    const parentIndex = stack.at(-1) ?? null
    const siblings = parentIndex === null ? roots : nodes[parentIndex]!.children
    const previousSibling = siblings.at(-1)
    if (previousSibling !== undefined) {
      nodes[previousSibling]!.followingSibling = true
    }
    siblings.push(index)
    nodes.push({ row, parentIndex, children: [], endIndex: rows.length, followingSibling: false })
    indexByRowKey.set(row.rowKey, index)
    const sameId = indexesByWorktreeId.get(row.worktree.id) ?? []
    sameId.push(index)
    indexesByWorktreeId.set(row.worktree.id, sameId)
    stack.push(index)
  }
  return { nodes, roots, indexByRowKey, indexesByWorktreeId }
}

export function retainLineageVirtualAncestors(
  tree: LineageVirtualTree,
  indexes: Iterable<number>
): ReadonlySet<number> {
  const retained = new Set<number>()
  for (const index of indexes) {
    let cursor: number | null = index
    while (cursor !== null && tree.nodes[cursor] && !retained.has(cursor)) {
      retained.add(cursor)
      cursor = tree.nodes[cursor]!.parentIndex
    }
  }
  return retained
}

export function getLineageVirtualOffsets(
  tree: LineageVirtualTree,
  measuredHeights: ReadonlyMap<string, number>
): number[] {
  const offsets = [0]
  for (const node of tree.nodes) {
    offsets.push(
      offsets.at(-1)! + (measuredHeights.get(node.row.rowKey) ?? ESTIMATED_LINEAGE_CARD_HEIGHT)
    )
  }
  return offsets
}

export function getLineageRevealMeasurementIndexes(
  index: number,
  offsets: readonly number[],
  viewportHeight: number
): number[] {
  let start = index
  let end = index
  const lastIndex = offsets.length - 2
  while (start > 0 && offsets[index]! - offsets[start]! < viewportHeight) {
    start--
  }
  while (end < lastIndex && offsets[end + 1]! - offsets[index + 1]! < viewportHeight) {
    end++
  }
  start = Math.max(0, start - LINEAGE_VIRTUAL_OVERSCAN)
  end = Math.min(lastIndex, end + LINEAGE_VIRTUAL_OVERSCAN)
  return Array.from({ length: end - start + 1 }, (_, offset) => start + offset)
}

export type LineageVirtualChildSpan =
  | { type: 'row'; index: number }
  | { type: 'spacer'; key: string; height: number }

export function getLineageVirtualChildSpans(
  tree: LineageVirtualTree,
  children: readonly number[],
  retained: ReadonlySet<number>,
  offsets: readonly number[]
): LineageVirtualChildSpan[] {
  const spans: LineageVirtualChildSpan[] = []
  let cursor = 0
  while (cursor < children.length) {
    const index = children[cursor]!
    if (retained.has(index)) {
      spans.push({ type: 'row', index })
      cursor++
      continue
    }
    let last = index
    while (cursor < children.length && !retained.has(children[cursor]!)) {
      last = children[cursor++]!
    }
    const lastNode = tree.nodes[last]!
    spans.push({
      type: 'spacer',
      key: tree.nodes[index]!.row.rowKey,
      // The surrounding space-y supplies the final sibling gap, including for a spacer.
      height:
        offsets[lastNode.endIndex]! -
        offsets[index]! -
        (lastNode.followingSibling ? LINEAGE_SIBLING_GAP : 0)
    })
  }
  return spans
}
