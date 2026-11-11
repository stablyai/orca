import { useEffect, useMemo } from 'react'
import type { AppState } from '@/store/types'
import {
  isHostAuthoritativeLayout,
  planTerminalLiveLayoutInsertions,
  planTerminalLiveLayoutRemovals,
  selectRetiredPaneIds,
  trackRetiredLeafIds
} from './terminal-live-layout-reconciliation'
import { collectLeafIds } from '../../../../../../shared/workspace-layout/terminal-pane-layout-tree'
import type { TerminalPaneCloseController } from '../close/use-terminal-pane-close-actions'
import { useAppStore } from '@/store/index'

export function useHostTerminalLayoutReconciliation({
  executeClosePane,
  hostRetiredLeafIdsRef,
  isActive,
  managerRef,
  paneCount,
  paneTransportsRef,
  persistLayoutSnapshot,
  ptyRecoveryStatesByPaneId,
  restoredLayout,
  hostLayoutLeafIdsRef,
  tabId
}: Pick<
  TerminalPaneCloseController,
  | 'executeClosePane'
  | 'hostRetiredLeafIdsRef'
  | 'isActive'
  | 'managerRef'
  | 'paneCount'
  | 'paneTransportsRef'
  | 'persistLayoutSnapshot'
  | 'ptyRecoveryStatesByPaneId'
  | 'restoredLayout'
  | 'tabId'
> & { hostLayoutLeafIdsRef: React.RefObject<ReadonlySet<string>> }): void {
  const selectHasRetainedStart = useMemo(() => {
    const paneKeys = collectLeafIds(restoredLayout.root).map((leafId) => `${tabId}:${leafId}`)
    let previous: AppState['terminalPaneStartsByPaneKey'] | undefined
    let result = false
    return (state: AppState): boolean => {
      if (previous !== state.terminalPaneStartsByPaneKey) {
        previous = state.terminalPaneStartsByPaneKey
        result = paneKeys.some((key) =>
          Boolean(state.terminalPaneStartsByPaneKey[key]?.retainedTerminalStart)
        )
      }
      return result
    }
  }, [restoredLayout.root, tabId])
  const hasRetainedStart = useAppStore(selectHasRetainedStart)
  useEffect(() => {
    const manager = managerRef.current
    if (!manager || !restoredLayout.root) {
      return
    }
    // Why the retired check: dropping a retired leaf can drop the layout's only remote PTY id.
    if (
      hostRetiredLeafIdsRef.current.size === 0 &&
      !hasRetainedStart &&
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
      retiredLeafIds: hostRetiredLeafIdsRef.current,
      previousLayoutLeafIds: hostLayoutLeafIdsRef.current,
      layoutLeafIds,
      mountedLeafIds
    })
    hostLayoutLeafIdsRef.current = layoutLeafIds
    hostRetiredLeafIdsRef.current = retiredLeafIds
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
      const retained =
        useAppStore.getState().terminalPaneStartsByPaneKey[`${tabId}:${insertion.newLeafId}`]
          ?.retainedTerminalStart
      const sourcePaneId = manager.getNumericIdForLeaf(insertion.sourceLeafId)
      if (
        (!ptyId && !retained) ||
        sourcePaneId === null ||
        manager.getNumericIdForLeaf(insertion.newLeafId) !== null
      ) {
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
          ...(ptyId ? { ptyId } : {}),
          activate: false,
          placement: insertion.placement
        }
      )
      if (createdPane) {
        appliedInsertion = true
      }
    }
    // Close host-retired panes only after their PTYs clear; recovery-state changes retry pending exits, preventing blank ghosts without killing live terminals.
    const retiredPaneIds = selectRetiredPaneIds(removals, {
      paneCount: manager.getPanes().length,
      paneIdForLeaf: (leafId) => manager.getNumericIdForLeaf(leafId),
      ptyIdForPane: (paneId) => paneTransportsRef.current.get(paneId)?.getPtyId()
    })
    for (const paneId of retiredPaneIds) {
      // Host-retired PTY-less panes: housekeeping, never a user close of the tab.
      executeClosePane(paneId, 'cleanup')
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
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- hostLayoutLeafIdsRef keeps the same mount-owned identity.
  }, [
    executeClosePane,
    isActive,
    paneCount,
    persistLayoutSnapshot,
    ptyRecoveryStatesByPaneId,
    restoredLayout,
    hostRetiredLeafIdsRef,
    managerRef,
    paneTransportsRef,
    tabId,
    hasRetainedStart
  ])
}
