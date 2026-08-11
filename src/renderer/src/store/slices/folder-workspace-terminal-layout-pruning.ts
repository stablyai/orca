import type { TerminalLayoutSnapshot, TerminalPaneLayoutNode } from '../../../../shared/types'
import {
  folderWorkspaceTerminalOwnerOwnsPty,
  type FolderWorkspaceTerminalOwner
} from './folder-workspace-terminal-owner'

function pruneLayoutNode(
  node: TerminalPaneLayoutNode | null,
  removedLeafIds: ReadonlySet<string>
): TerminalPaneLayoutNode | null {
  if (!node) {
    return null
  }
  if (node.type === 'leaf') {
    return removedLeafIds.has(node.leafId) ? null : node
  }
  const first = pruneLayoutNode(node.first, removedLeafIds)
  const second = pruneLayoutNode(node.second, removedLeafIds)
  if (!first) {
    return second
  }
  if (!second) {
    return first
  }
  return first === node.first && second === node.second ? node : { ...node, first, second }
}

function firstLayoutLeafId(node: TerminalPaneLayoutNode | null): string | null {
  if (!node) {
    return null
  }
  return node.type === 'leaf' ? node.leafId : firstLayoutLeafId(node.first)
}

function omitRemovedLeafRecords(
  source: Record<string, string> | undefined,
  removedLeafIds: ReadonlySet<string>
): Record<string, string> | undefined {
  if (!source || !Object.keys(source).some((leafId) => removedLeafIds.has(leafId))) {
    return source
  }
  const next = Object.fromEntries(
    Object.entries(source).filter(([leafId]) => !removedLeafIds.has(leafId))
  )
  return Object.keys(next).length > 0 ? next : undefined
}

export function pruneOwnedTerminalLayout(
  layout: TerminalLayoutSnapshot | undefined,
  owner: FolderWorkspaceTerminalOwner
): { layout: TerminalLayoutSnapshot | null; removedLeafIds: string[] } {
  const removedLeafIds = new Set(
    Object.entries(layout?.ptyIdsByLeafId ?? {})
      .filter(([, ptyId]) => folderWorkspaceTerminalOwnerOwnsPty(owner, ptyId))
      .map(([leafId]) => leafId)
  )
  if (!layout || removedLeafIds.size === 0) {
    return { layout: layout ?? null, removedLeafIds: [] }
  }
  const root = pruneLayoutNode(layout.root, removedLeafIds)
  if (!root) {
    return { layout: null, removedLeafIds: [...removedLeafIds] }
  }
  const activeLeafId =
    layout.activeLeafId && !removedLeafIds.has(layout.activeLeafId)
      ? layout.activeLeafId
      : firstLayoutLeafId(root)
  const ptyIdsByLeafId = omitRemovedLeafRecords(layout.ptyIdsByLeafId, removedLeafIds)
  const buffersByLeafId = omitRemovedLeafRecords(layout.buffersByLeafId, removedLeafIds)
  const scrollbackRefsByLeafId = omitRemovedLeafRecords(
    layout.scrollbackRefsByLeafId,
    removedLeafIds
  )
  const titlesByLeafId = omitRemovedLeafRecords(layout.titlesByLeafId, removedLeafIds)
  return {
    removedLeafIds: [...removedLeafIds],
    layout: {
      root,
      activeLeafId,
      expandedLeafId:
        root.type !== 'leaf' && layout.expandedLeafId && !removedLeafIds.has(layout.expandedLeafId)
          ? layout.expandedLeafId
          : null,
      ...(ptyIdsByLeafId ? { ptyIdsByLeafId } : {}),
      ...(buffersByLeafId ? { buffersByLeafId } : {}),
      ...(scrollbackRefsByLeafId ? { scrollbackRefsByLeafId } : {}),
      ...(titlesByLeafId ? { titlesByLeafId } : {})
    }
  }
}
