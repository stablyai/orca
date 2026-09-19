import type {
  TerminalPaneLayoutNode,
  TerminalPaneSplitDirection
} from '../../../../shared/terminal-tab-types'
import { isRemoteRuntimePtyId } from '@/runtime/runtime-terminal-inspection'
import { collectLeafIds } from './terminal-pane-layout-tree'

/**
 * Whether a tab's split layout is owned by a host (web/mobile clients, or a
 * desktop client viewing a remote "Orca server" worktree) rather than built
 * locally. Such layouts arrive via the host snapshot, so the live-layout
 * reconciler must materialize their panes. A desktop client only needs this for
 * remote-runtime tabs — local tabs split their panes directly.
 */
export function isHostAuthoritativeLayout(args: {
  isWebClient: boolean
  ptyIdsByLeafId: Record<string, string> | undefined
}): boolean {
  if (args.isWebClient) {
    return true
  }
  return Object.values(args.ptyIdsByLeafId ?? {}).some(
    (ptyId) => typeof ptyId === 'string' && isRemoteRuntimePtyId(ptyId)
  )
}

export type TerminalLiveLayoutInsertion = {
  sourceLeafId: string
  sourceLeafIds: string[]
  newLeafId: string
  direction: TerminalPaneSplitDirection
  placement: 'before' | 'after'
  ratio?: number
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

function leftmostMountedLeafId(
  node: TerminalPaneLayoutNode,
  mountedLeafIds: ReadonlySet<string>
): string | null {
  if (node.type === 'leaf') {
    return mountedLeafIds.has(node.leafId) ? node.leafId : null
  }
  return (
    leftmostMountedLeafId(node.first, mountedLeafIds) ??
    leftmostMountedLeafId(node.second, mountedLeafIds)
  )
}

function hasMountedLeaf(
  node: TerminalPaneLayoutNode,
  mountedLeafIds: ReadonlySet<string>
): boolean {
  if (node.type === 'leaf') {
    return mountedLeafIds.has(node.leafId)
  }
  return hasMountedLeaf(node.first, mountedLeafIds) || hasMountedLeaf(node.second, mountedLeafIds)
}

function mountedLeafIdsIn(
  node: TerminalPaneLayoutNode,
  mountedLeafIds: ReadonlySet<string>
): string[] {
  if (node.type === 'leaf') {
    return mountedLeafIds.has(node.leafId) ? [node.leafId] : []
  }
  return [
    ...mountedLeafIdsIn(node.first, mountedLeafIds),
    ...mountedLeafIdsIn(node.second, mountedLeafIds)
  ]
}

/** Missing layouts are not retirement evidence. */
export function planTerminalLiveLayoutRemovals(
  root: TerminalPaneLayoutNode | null | undefined,
  currentLeafIds: Iterable<string>,
  retiredLeafIds: ReadonlySet<string>
): string[] {
  if (!root) {
    return []
  }
  const layoutLeafIds = new Set(collectLeafIds(root))
  // Never treat a client-starting leaf the host has not yet named as retired.
  return [...currentLeafIds].filter(
    (leafId) => !layoutLeafIds.has(leafId) && retiredLeafIds.has(leafId)
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

    const firstHasMounted = hasMountedLeaf(node.first, mountedLeafIds)
    const secondHasMounted = hasMountedLeaf(node.second, mountedLeafIds)
    if (!firstHasMounted && !secondHasMounted) {
      return false
    }

    // Why: bridge the current split before filling nested descendants; once a
    // child subtree is split internally, PaneManager can no longer wrap it as
    // this split's sibling using a leaf-only splitPane call.
    if (firstHasMounted && !secondHasMounted) {
      const sourceLeafId = rightmostMountedLeafId(node.first, mountedLeafIds)
      const newLeafId = leftmostLeafId(node.second)
      if (sourceLeafId && !mountedLeafIds.has(newLeafId)) {
        insertions.push({
          sourceLeafId,
          sourceLeafIds: mountedLeafIdsIn(node.first, mountedLeafIds),
          newLeafId,
          direction: node.direction,
          placement: 'after',
          ratio: node.ratio
        })
        mountedLeafIds.add(newLeafId)
      }
      ensureSubtree(node.second)
      ensureSubtree(node.first)
      return true
    }

    if (!firstHasMounted && secondHasMounted) {
      const sourceLeafId = leftmostMountedLeafId(node.second, mountedLeafIds)
      const newLeafId = leftmostLeafId(node.first)
      if (sourceLeafId && !mountedLeafIds.has(newLeafId)) {
        insertions.push({
          sourceLeafId,
          sourceLeafIds: mountedLeafIdsIn(node.second, mountedLeafIds),
          newLeafId,
          direction: node.direction,
          placement: 'before',
          ratio: node.ratio
        })
        mountedLeafIds.add(newLeafId)
      }
      ensureSubtree(node.first)
      ensureSubtree(node.second)
      return true
    }

    ensureSubtree(node.first)
    ensureSubtree(node.second)
    return true
  }

  ensureSubtree(root)
  return insertions
}

/** Host-retired leaves still require a cleared transport; preserve the last pane. */
export function selectRetiredPaneIds(
  retiredLeafIds: readonly string[],
  view: {
    paneCount: number
    paneIdForLeaf: (leafId: string) => number | null
    ptyIdForPane: (paneId: number) => string | null | undefined
  }
): number[] {
  const paneIds: number[] = []
  for (const leafId of retiredLeafIds) {
    if (view.paneCount - paneIds.length <= 1) {
      break
    }
    const paneId = view.paneIdForLeaf(leafId)
    if (paneId === null || view.ptyIdForPane(paneId) !== null) {
      continue
    }
    paneIds.push(paneId)
  }
  return paneIds
}

/** Retain deferred removals until unmount or reintroduction by an accepted host layout. */
export function trackRetiredLeafIds(args: {
  retiredLeafIds: ReadonlySet<string>
  previousLayoutLeafIds: ReadonlySet<string>
  layoutLeafIds: ReadonlySet<string>
  mountedLeafIds: Iterable<string>
}): ReadonlySet<string> {
  const mounted = new Set(args.mountedLeafIds)
  const next = new Set<string>()
  for (const leafId of [...args.retiredLeafIds, ...args.previousLayoutLeafIds]) {
    if (mounted.has(leafId) && !args.layoutLeafIds.has(leafId)) {
      next.add(leafId)
    }
  }
  return next
}
