import type { WorktreeItemRow } from './renderable-rows'

export const LINEAGE_SIBLING_GAP = 4

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
