import type { TerminalLayoutSnapshot, TerminalPaneLayoutNode } from '../../../../shared/types'
import {
  collectLeafIdsInOrder,
  normalizeTerminalLayoutSnapshot,
  resolveTerminalLayoutActiveLeafId
} from './terminal-layout-leaf-ids'

export type DetachedTerminalLayoutLeaf = {
  sourceLayout: TerminalLayoutSnapshot
  detachedLayout: TerminalLayoutSnapshot
  ptyId: string | null
}

function removeLeafFromTree(
  node: TerminalPaneLayoutNode,
  leafId: string
): { node: TerminalPaneLayoutNode | null; removed: boolean } {
  if (node.type === 'leaf') {
    return node.leafId === leafId ? { node: null, removed: true } : { node, removed: false }
  }

  const first = removeLeafFromTree(node.first, leafId)
  const second = removeLeafFromTree(node.second, leafId)
  if (!first.removed && !second.removed) {
    return { node, removed: false }
  }
  if (!first.node) {
    return { node: second.node, removed: true }
  }
  if (!second.node) {
    return { node: first.node, removed: true }
  }
  return {
    node: {
      ...node,
      first: first.node,
      second: second.node
    },
    removed: true
  }
}

function omitLeafRecord(
  source: Record<string, string> | undefined,
  leafId: string
): Record<string, string> | undefined {
  if (!source || !Object.prototype.hasOwnProperty.call(source, leafId)) {
    return source
  }
  const next = { ...source }
  delete next[leafId]
  return Object.keys(next).length > 0 ? next : undefined
}

function singleLeafRecord(
  source: Record<string, string> | undefined,
  leafId: string
): Record<string, string> | undefined {
  const value = source?.[leafId]
  return value ? { [leafId]: value } : undefined
}

export function detachTerminalLayoutLeaf(
  snapshot: TerminalLayoutSnapshot | null | undefined,
  leafId: string
): DetachedTerminalLayoutLeaf | null {
  const layout = normalizeTerminalLayoutSnapshot(snapshot).snapshot
  if (!layout.root) {
    return null
  }

  const originalLeafIds = collectLeafIdsInOrder(layout.root)
  if (!originalLeafIds.includes(leafId) || originalLeafIds.length <= 1) {
    return null
  }

  const removal = removeLeafFromTree(layout.root, leafId)
  if (!removal.removed || !removal.node) {
    return null
  }

  const ptyIdsByLeafId = omitLeafRecord(layout.ptyIdsByLeafId, leafId)
  const buffersByLeafId = omitLeafRecord(layout.buffersByLeafId, leafId)
  const scrollbackRefsByLeafId = omitLeafRecord(layout.scrollbackRefsByLeafId, leafId)
  const titlesByLeafId = omitLeafRecord(layout.titlesByLeafId, leafId)
  const sourceLayout: TerminalLayoutSnapshot = {
    root: removal.node,
    activeLeafId: resolveTerminalLayoutActiveLeafId({
      root: removal.node,
      activeLeafId: layout.activeLeafId === leafId ? null : layout.activeLeafId,
      ptyIdsByLeafId
    }),
    expandedLeafId: layout.expandedLeafId === leafId ? null : layout.expandedLeafId,
    ...(ptyIdsByLeafId ? { ptyIdsByLeafId } : {}),
    ...(buffersByLeafId ? { buffersByLeafId } : {}),
    ...(scrollbackRefsByLeafId ? { scrollbackRefsByLeafId } : {}),
    ...(titlesByLeafId ? { titlesByLeafId } : {})
  }

  const detachedPtyIdsByLeafId = singleLeafRecord(layout.ptyIdsByLeafId, leafId)
  const detachedBuffersByLeafId = singleLeafRecord(layout.buffersByLeafId, leafId)
  const detachedScrollbackRefsByLeafId = singleLeafRecord(layout.scrollbackRefsByLeafId, leafId)
  const detachedTitlesByLeafId = singleLeafRecord(layout.titlesByLeafId, leafId)
  return {
    sourceLayout,
    detachedLayout: {
      root: { type: 'leaf', leafId },
      activeLeafId: leafId,
      expandedLeafId: null,
      ...(detachedPtyIdsByLeafId ? { ptyIdsByLeafId: detachedPtyIdsByLeafId } : {}),
      ...(detachedBuffersByLeafId ? { buffersByLeafId: detachedBuffersByLeafId } : {}),
      ...(detachedScrollbackRefsByLeafId
        ? { scrollbackRefsByLeafId: detachedScrollbackRefsByLeafId }
        : {}),
      ...(detachedTitlesByLeafId ? { titlesByLeafId: detachedTitlesByLeafId } : {})
    },
    ptyId: detachedPtyIdsByLeafId?.[leafId] ?? null
  }
}
