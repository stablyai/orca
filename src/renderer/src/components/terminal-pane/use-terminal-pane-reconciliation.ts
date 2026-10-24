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
  isPtyBoundInAnotherTab,
  planTerminalLiveLayoutInsertions,
  planTerminalLiveLayoutRemovals,
  selectRetiredPaneIds,
  trackRetiredLeafIds
} from './terminal-live-layout-reconciliation'
import { collectLeafIds } from '../../../../shared/terminal-pane-layout-tree'
import { useTerminalPaneProcessExitActions } from './use-terminal-pane-process-exit-actions'
import type { TerminalPaneCloseController } from './use-terminal-pane-close-actions'
import { useAppStore } from '../../store'
import { detachExternallyMovedPane } from './terminal-pane-external-move-detach'

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
    ptyRecoveryStatesByPaneId,
    restoredLayout,
    tabId,
    worktreeId
  } = controller
  // Leaves the last host-authoritative layout named, and the ones it has since
  // dropped whose panes are still mounted; a removal needs the host to have
  // named the leaf before it dropped it, and may have to wait for the PTY exit.
  const hostLayoutLeafIdsRef = useRef<ReadonlySet<string>>(new Set())
  const retiredLeafIdsRef = useRef<ReadonlySet<string>>(new Set())

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
    const layoutLeafIds = new Set(collectLeafIds(restoredLayout.root))
    const mountedLeafIds = manager.getPanes().map((pane) => pane.leafId)
    const retiredLeafIds = trackRetiredLeafIds({
      retiredLeafIds: retiredLeafIdsRef.current,
      previousLayoutLeafIds: hostLayoutLeafIdsRef.current,
      layoutLeafIds,
      mountedLeafIds
    })
    hostLayoutLeafIdsRef.current = layoutLeafIds
    retiredLeafIdsRef.current = retiredLeafIds
    const insertions = planTerminalLiveLayoutInsertions(restoredLayout.root, mountedLeafIds)
    const removals = planTerminalLiveLayoutRemovals(
      restoredLayout.root,
      mountedLeafIds,
      retiredLeafIds
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
    // Why: a host-retired pane is a ghost once its PTY ended, or another client moved it when another
    // tab binds its live PTY; one still ending is removed on the ptyRecoveryStatesByPaneId re-run.
    const { closed, moved } = selectRetiredPaneIds(removals, {
      paneCount: manager.getPanes().length,
      paneIdForLeaf: (leafId) => manager.getNumericIdForLeaf(leafId),
      ptyIdForPane: (paneId) => paneTransportsRef.current.get(paneId)?.getPtyId(),
      isPtyBoundInAnotherTab: (ptyId) =>
        isPtyBoundInAnotherTab(useAppStore.getState(), worktreeId, tabId, ptyId)
    })
    for (const paneId of closed) {
      executeClosePane(paneId)
    }
    for (const paneId of moved) {
      detachExternallyMovedPane({
        manager,
        paneId,
        tabId,
        retireAgentPaneAuthority: (paneKey) =>
          useAppStore.getState().retireAgentPaneAuthority(paneKey)
      })
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
    // Why ptyRecoveryStatesByPaneId: a host-retired pane whose PTY has not yet
    // finished ending is kept until this re-run, when its transport reports a new
    // recovery state and its PTY has cleared.
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Preserve the pre-split dependency contract.
  }, [
    executeClosePane,
    isActive,
    paneCount,
    persistLayoutSnapshot,
    ptyRecoveryStatesByPaneId,
    restoredLayout
  ])

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
