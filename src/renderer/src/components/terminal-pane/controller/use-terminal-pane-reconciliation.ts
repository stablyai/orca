import { useTerminalLinkActionDismissal } from '../links/use-terminal-link-action-dismissal'
import { useHostTerminalLayoutReconciliation } from '../layout/reconciliation/use-host-terminal-layout-reconciliation'
import { useTerminalPaneActivityIsolation } from '../layout/isolation/use-terminal-pane-activity-isolation'
import { useRef } from 'react'
import { useTerminalPaneProcessExitActions } from './use-terminal-pane-process-exit-actions'
import type { TerminalPaneCloseController } from '../layout/close/use-terminal-pane-close-actions'

export function useTerminalPaneReconciliation(controller: TerminalPaneCloseController) {
  const {
    activityIsolationSnapshotRef,
    closeTerminalLinkActions,
    containerRef,
    executeClosePane,
    hostRetiredLeafIdsRef,
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
    tabId
  } = controller
  // Retain the last host layout to prove leaf retirement, which may wait for PTY exit.
  const hostLayoutLeafIdsRef = useRef<ReadonlySet<string>>(new Set())

  useTerminalLinkActionDismissal({
    closeTerminalLinkActions,
    isActive,
    isRendererVisible,
    paneLayoutRevision
  })

  useHostTerminalLayoutReconciliation({
    executeClosePane,
    hostRetiredLeafIdsRef,
    isActive,
    managerRef,
    paneCount,
    paneTransportsRef,
    persistLayoutSnapshot,
    ptyRecoveryStatesByPaneId,
    restoredLayout,
    hostLayoutLeafIdsRef
  })

  useTerminalPaneActivityIsolation({
    activityIsolationSnapshotRef,
    containerRef,
    isolatedPaneKey,
    managerRef,
    paneCount,
    pendingPaneSizeRefreshFrameIdsRef,
    tabId
  })

  const processExitActions = useTerminalPaneProcessExitActions(controller)

  return processExitActions
}
