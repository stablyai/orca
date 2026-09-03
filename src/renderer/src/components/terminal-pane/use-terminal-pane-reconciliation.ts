import { useEffect, useLayoutEffect } from 'react'
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
  planTerminalLiveLayoutRemovals
} from './terminal-live-layout-reconciliation'
import { useTerminalPaneProcessExitActions } from './use-terminal-pane-process-exit-actions'
import type { TerminalPaneCloseController } from './use-terminal-pane-close-actions'

export function useTerminalPaneReconciliation(controller: TerminalPaneCloseController) {
  const {
    activityIsolationSnapshotRef,
    closeTerminalLinkActions,
    containerRef,
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
    const mountedLeafIds = manager.getPanes().map((pane) => pane.leafId)
    const insertions = planTerminalLiveLayoutInsertions(restoredLayout.root, mountedLeafIds)
    const removals = planTerminalLiveLayoutRemovals(restoredLayout.root, mountedLeafIds)
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
    // close for themselves. A pane still bound to a PTY is not a ghost — a stale
    // snapshot may simply not name it yet — and the last pane is never removed.
    for (const leafId of removals) {
      const paneId = manager.getNumericIdForLeaf(leafId)
      if (paneId === null || manager.getPanes().length <= 1) {
        continue
      }
      const transport = paneTransportsRef.current.get(paneId)
      if (!transport || transport.getPtyId() !== null) {
        continue
      }
      manager.closePane(paneId)
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
  }, [isActive, paneCount, persistLayoutSnapshot, restoredLayout])

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
