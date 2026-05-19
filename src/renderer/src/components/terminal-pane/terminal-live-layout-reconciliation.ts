import type { TerminalPaneLayoutNode, TerminalPaneSplitDirection } from '../../../../shared/types'

export type TerminalLiveLayoutInsertion = {
  sourceLeafId: string
  newLeafId: string
  direction: TerminalPaneSplitDirection
}

function leftmostLeafId(node: TerminalPaneLayoutNode): string {
  return node.type === 'leaf' ? node.leafId : leftmostLeafId(node.first)
}

function rightmostMountedLeafId(
  node: TerminalPaneLayoutNode,
  mountedLeafIds: ReadonlySet<string>
): string | null {
  if (node.type === 'leaf') {
    return mountedLeafIds.has(node.leafId) ? node.leafId : null
  }
  return (
    rightmostMountedLeafId(node.second, mountedLeafIds) ??
    rightmostMountedLeafId(node.first, mountedLeafIds)
  )
}

export function planTerminalLiveLayoutInsertions(
  root: TerminalPaneLayoutNode | null | undefined,
  currentLeafIds: Iterable<string>
): TerminalLiveLayoutInsertion[] {
  if (!root) {
    return []
  }

  const mountedLeafIds = new Set(currentLeafIds)
  const insertions: TerminalLiveLayoutInsertion[] = []

  const ensureSubtree = (node: TerminalPaneLayoutNode): boolean => {
    if (node.type === 'leaf') {
      return mountedLeafIds.has(node.leafId)
    }

    const firstHasMounted = ensureSubtree(node.first)
    const secondHasMounted = ensureSubtree(node.second)
    if (!firstHasMounted) {
      return secondHasMounted
    }
    if (secondHasMounted) {
      return true
    }

    const sourceLeafId = rightmostMountedLeafId(node.first, mountedLeafIds)
    const newLeafId = leftmostLeafId(node.second)
    if (!sourceLeafId || mountedLeafIds.has(newLeafId)) {
      return true
    }

    insertions.push({
      sourceLeafId,
      newLeafId,
      direction: node.direction
    })
    mountedLeafIds.add(newLeafId)
    ensureSubtree(node.second)
    return true
  }

  ensureSubtree(root)
  return insertions
}
