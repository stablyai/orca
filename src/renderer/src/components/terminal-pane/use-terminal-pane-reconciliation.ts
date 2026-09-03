import { useEffect, useLayoutEffect, useRef } from 'react'
import {
  applyExpandedLayoutTo,
  cancelPendingPaneSizeRefreshFrames,
  restoreExpandedLayoutFrom
} from './expand-collapse'
import { safeFit } from '@/lib/pane-manager/pane-tree-ops'
import { resolvePaneKeyForManager } from '@/lib/pane-manager/pane-key-resolution'
import {
  isHostAuthoritativeLayout,
  planTerminalLiveLayoutInsertions,
  planTerminalLiveLayoutRemovals,
  selectRetiredPaneIds
} from './terminal-live-layout-reconciliation'
import { collectLeafIds } from './terminal-pane-layout-tree'
import { useTerminalPaneProcessExitActions } from './use-terminal-pane-process-exit-actions'
import type { TerminalPaneCloseController } from './use-terminal-pane-close-actions'

export function useTerminalPaneReconciliation(controller: TerminalPaneCloseController) {
  const {
    activityIsolationSnapshotRef,
    closeTerminalLinkActions,
    containerRef,
    executeClosePane,
    isActive,
    isRendererVisible,
    isolatedPaneKey,
    managerRef,
    paneCount,
    paneLayoutRevision,
    paneTransportsRef,
    pendingPaneSizeRefreshFrameIdsRef,
    persistLayoutSnapshot,
    restoredLayout,
    tabId
  } = controller
  // Leaves the last host-authoritative layout named; a removal needs the host to
  // have named the leaf before it dropped it.
  const hostLayoutLeafIdsRef = useRef<ReadonlySet<string>>(new Set())

  useEffect(() => {
    closeTerminalLinkActions()
  }, [closeTerminalLinkActions, isActive, isRendererVisible, paneLayoutRevision])

  useEffect(() => {
    const manager = managerRef.current
    if (!manager || !restoredLayout.root) {
      return
    }
    if (
      !isHostAuthoritativeLayout({
        isWebClient: !!(globalThis as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__,
        ptyIdsByLeafId: restoredLayout.ptyIdsByLeafId
      })
    ) {
      return
    }
    const previousHostLayoutLeafIds = hostLayoutLeafIdsRef.current
    hostLayoutLeafIdsRef.current = new Set(collectLeafIds(restoredLayout.root))
    const mountedLeafIds = manager.getPanes().map((pane) => pane.leafId)
    const insertions = planTerminalLiveLayoutInsertions(restoredLayout.root, mountedLeafIds)
    const removals = planTerminalLiveLayoutRemovals(
      restoredLayout.root,
      mountedLeafIds,
      previousHostLayoutLeafIds
    )
    if (insertions.length === 0 && removals.length === 0) {
      return
    }
    let appliedInsertion = false
    for (const insertion of insertions) {
      const ptyId = restoredLayout.ptyIdsByLeafId?.[insertion.newLeafId]
      const sourcePaneId = manager.getNumericIdForLeaf(insertion.sourceLeafId)
      if (!ptyId || sourcePaneId === null || manager.getNumericIdForLeaf(insertion.newLeafId)) {
        continue
      }
      const splitRatio =
        insertion.ratio === undefined
          ? undefined
          : insertion.placement === 'before'
            ? 1 - insertion.ratio
            : insertion.ratio
      const createdPane = manager.splitPaneAroundLeafIds(
        insertion.sourceLeafIds,
        sourcePaneId,
        insertion.direction,
        {
          ...(splitRatio !== undefined && { ratio: splitRatio }),
          leafId: insertion.newLeafId,
          ptyId,
          placement: insertion.placement
        }
      )
      if (createdPane) {
        appliedInsertion = true
      }
    }
    // Why: the host retired these leaves (its PTY for them ended), so their panes
    // would otherwise outlive the layout as blank ghosts and take the tab's next
    // close for themselves. Closing through executeClosePane runs the same
    // cleanup a user close does: cache timer, agent status, terminal error,
    // restored-session banner and the leaf's pty binding.
    const retiredPaneIds = selectRetiredPaneIds(removals, {
      paneCount: manager.getPanes().length,
      paneIdForLeaf: (leafId) => manager.getNumericIdForLeaf(leafId),
      ptyIdForPane: (paneId) => paneTransportsRef.current.get(paneId)?.getPtyId()
    })
    for (const paneId of retiredPaneIds) {
      executeClosePane(paneId)
    }
    if (appliedInsertion) {
      persistLayoutSnapshot()
    }
    const activePaneId = restoredLayout.activeLeafId
      ? manager.getNumericIdForLeaf(restoredLayout.activeLeafId)
      : null
    const fallbackActivePaneId = manager.getActivePane()?.id ?? manager.getPanes()[0]?.id ?? null
    const nextActivePaneId = activePaneId ?? fallbackActivePaneId
    if (nextActivePaneId !== null) {
      manager.setActivePane(nextActivePaneId, { focus: isActive })
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Preserve the pre-split dependency contract.
  }, [executeClosePane, isActive, paneCount, persistLayoutSnapshot, restoredLayout])

  useLayoutEffect(() => {
    const snapshots = activityIsolationSnapshotRef.current
    const scheduleRefit = (): number =>
      requestAnimationFrame(() => {
        const manager = managerRef.current
        if (!manager) {
          return
        }
        for (const pane of manager.getPanes()) {
          safeFit(pane)
        }
      })
    if (isolatedPaneKey === null) {
      restoreExpandedLayoutFrom(snapshots)
      const frame = scheduleRefit()
      return () => cancelAnimationFrame(frame)
    }
    const manager = managerRef.current
    const resolution = resolvePaneKeyForManager(tabId, isolatedPaneKey, manager)
    const resolvedPaneId = resolution.status === 'resolved' ? resolution.numericPaneId : null
    const applied =
      resolvedPaneId !== null &&
      ((manager?.getPanes().length ?? 0) <= 1 ||
        applyExpandedLayoutTo(resolvedPaneId, {
          managerRef,
          containerRef,
          expandedStyleSnapshotRef: activityIsolationSnapshotRef
        }))
    if (!applied) {
      restoreExpandedLayoutFrom(snapshots)
      const root = containerRef.current?.firstElementChild
      if (root instanceof HTMLElement) {
        snapshots.set(root, { display: root.style.display, flex: root.style.flex })
        root.style.display = 'none'
      }
      const frame = scheduleRefit()
      return () => cancelAnimationFrame(frame)
    }
    const frame = scheduleRefit()
    return () => cancelAnimationFrame(frame)
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Preserve the pre-split dependency contract.
  }, [isolatedPaneKey, paneCount, tabId])

  useEffect(() => {
    const snapshots = activityIsolationSnapshotRef.current
    return () => {
      restoreExpandedLayoutFrom(snapshots)
      cancelPendingPaneSizeRefreshFrames({ pendingPaneSizeRefreshFrameIdsRef })
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Preserve the pre-split dependency contract.
  }, [])

  const processExitActions = useTerminalPaneProcessExitActions(controller)

  return processExitActions
}
