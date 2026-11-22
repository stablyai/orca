import { useEffect } from 'react'
import { registerPaneAgentRestartExecutor } from '@/lib/agent-session/resume/pane-agent-restart'
import { usePaneAccountRestartStartup } from '../account-restart/use-pane-account-restart-startup'
import { usePaneProcessRestart } from '../process-exit/use-pane-process-restart'
import { useExitedPaneActions } from '../process-exit/use-exited-pane-actions'
import { useSavedPanePtyBindings } from '../layout/ownership/use-saved-pane-pty-bindings'
import { useReadyPaneAccountRestarts } from '../account-restart/use-ready-pane-account-restarts'

import type { TerminalPaneCloseController } from '../layout/close/use-terminal-pane-close-actions'

export function useTerminalPaneProcessExitActions(controller: TerminalPaneCloseController) {
  const {
    clearCodexRestartNotice,
    clearExitedPanePtyLayoutBinding,
    clearRuntimePaneTitle,
    clearTabPtyId,
    consumePendingPaneAccountRestart,
    cwd,
    dispatchNotification,
    executeClosePane,
    initialLayoutRef,
    isActiveRef,
    isVisibleRef,
    markTerminalBell,
    handlePaneProcessDied,
    managerRef,
    onAgentExitedRef,
    onPtyErrorClearedRef,
    onPtyErrorRef,
    onPtyExitRef,
    onPtyRecoveryStateRef,
    paneKittyKeyboardModesRef,
    paneLastThemeModeRef,
    paneMode2031Ref,
    panePtyBindingsRef,
    paneTransportsRef,
    replayingPanesRef,
    savedLayout,
    setCacheTimerStartedAt,
    setPaneProcessExitsByPaneId,
    setRuntimePaneTitle,
    setTerminalError,
    setTerminalErrorsByPaneId,
    showRestoredSessionBanner,
    suppressPtyExit,
    syncPanePtyLayoutBinding,
    tabId,
    updateTabPtyId,
    updateTabTitle,
    worktreeId
  } = controller

  const { buildAccountRestartStartup } = usePaneAccountRestartStartup({ tabId, worktreeId })

  const { handleRestartPane } = usePaneProcessRestart({
    clearCodexRestartNotice,
    clearExitedPanePtyLayoutBinding,
    clearRuntimePaneTitle,
    clearTabPtyId,
    cwd,
    dispatchNotification,
    initialLayoutRef,
    isActiveRef,
    isVisibleRef,
    markTerminalBell,
    handlePaneProcessDied,
    managerRef,
    onAgentExitedRef,
    onPtyErrorClearedRef,
    onPtyErrorRef,
    onPtyExitRef,
    onPtyRecoveryStateRef,
    paneKittyKeyboardModesRef,
    paneLastThemeModeRef,
    paneMode2031Ref,
    panePtyBindingsRef,
    paneTransportsRef,
    replayingPanesRef,
    setCacheTimerStartedAt,
    setRuntimePaneTitle,
    setTerminalError,
    setTerminalErrorsByPaneId,
    showRestoredSessionBanner,
    suppressPtyExit,
    syncPanePtyLayoutBinding,
    tabId,
    updateTabPtyId,
    updateTabTitle,
    worktreeId
  })

  const { handleRestartExitedPane, handleCloseExitedPane } = useExitedPaneActions({
    executeClosePane,
    setPaneProcessExitsByPaneId,
    handleRestartPane
  })

  const { panePtyLayoutBindings } = useSavedPanePtyBindings({
    managerRef,
    paneTransportsRef,
    savedLayout,
    tabId
  })

  // A chat's Resume or Start new session restarts its pane in place, as an account switch does.
  useEffect(
    () =>
      registerPaneAgentRestartExecutor(tabId, (leafId, startup) => {
        const pane = managerRef.current?.getPanes().find((candidate) => candidate.leafId === leafId)
        if (!pane) {
          return false
        }
        handleRestartPane(pane.id, startup, { focus: false })
        return true
      }),
    [handleRestartPane, managerRef, tabId]
  )

  useReadyPaneAccountRestarts({
    consumePendingPaneAccountRestart,
    managerRef,
    paneTransportsRef,
    tabId,
    buildAccountRestartStartup,
    handleRestartPane,
    panePtyLayoutBindings
  })

  return { handleRestartExitedPane, handleCloseExitedPane }
}

export type TerminalPaneProcessExitController = ReturnType<typeof useTerminalPaneProcessExitActions>
