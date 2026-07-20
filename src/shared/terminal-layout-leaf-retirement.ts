import type { TerminalLayoutSnapshot, TerminalPaneLayoutNode } from './types'

export type TerminalLayoutLeafRetirement = {
  layout: TerminalLayoutSnapshot | null
  removedPtyId: string
}

function removeLeaf(node: TerminalPaneLayoutNode, leafId: string): TerminalPaneLayoutNode | null {
  if (node.type === 'leaf') {
    return node.leafId === leafId ? null : node
  }
  const first = removeLeaf(node.first, leafId)
  const second = removeLeaf(node.second, leafId)
  if (!first) {
    return second
  }
  if (!second) {
    return first
  }
  return { ...node, first, second }
}

function containsLeaf(node: TerminalPaneLayoutNode | null, leafId: string): boolean {
  if (!node) {
    return false
  }
  return node.type === 'leaf'
    ? node.leafId === leafId
    : containsLeaf(node.first, leafId) || containsLeaf(node.second, leafId)
}

function firstLeafId(node: TerminalPaneLayoutNode): string {
  return node.type === 'leaf' ? node.leafId : firstLeafId(node.first)
}

function omitLeaf(
  records: Record<string, string> | undefined,
  leafId: string
): Record<string, string> | undefined {
  if (!records || !Object.prototype.hasOwnProperty.call(records, leafId)) {
    return records
  }
  const next = { ...records }
  delete next[leafId]
  return Object.keys(next).length > 0 ? next : undefined
}

export function retireTerminalLayoutLeaf(
  layout: TerminalLayoutSnapshot | null | undefined,
  args: { leafId: string; expectedPtyId: string }
): TerminalLayoutLeafRetirement | null {
  if (
    !layout?.root ||
    !containsLeaf(layout.root, args.leafId) ||
    layout.ptyIdsByLeafId?.[args.leafId] !== args.expectedPtyId
  ) {
    return null
  }
  const root = removeLeaf(layout.root, args.leafId)
  if (!root) {
    return { layout: null, removedPtyId: args.expectedPtyId }
  }
  const ptyIdsByLeafId = omitLeaf(layout.ptyIdsByLeafId, args.leafId)
  const buffersByLeafId = omitLeaf(layout.buffersByLeafId, args.leafId)
  const scrollbackRefsByLeafId = omitLeaf(layout.scrollbackRefsByLeafId, args.leafId)
  const titlesByLeafId = omitLeaf(layout.titlesByLeafId, args.leafId)
  const activeLeafId =
    layout.activeLeafId && containsLeaf(root, layout.activeLeafId)
      ? layout.activeLeafId
      : firstLeafId(root)
  return {
    removedPtyId: args.expectedPtyId,
    layout: {
      root,
      activeLeafId,
      expandedLeafId:
        layout.expandedLeafId && containsLeaf(root, layout.expandedLeafId)
          ? layout.expandedLeafId
          : null,
      ...(ptyIdsByLeafId ? { ptyIdsByLeafId } : {}),
      ...(buffersByLeafId ? { buffersByLeafId } : {}),
      ...(scrollbackRefsByLeafId ? { scrollbackRefsByLeafId } : {}),
      ...(titlesByLeafId ? { titlesByLeafId } : {})
    }
  }
}
