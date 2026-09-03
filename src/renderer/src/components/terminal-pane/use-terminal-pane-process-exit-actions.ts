import { useCallback, useEffect, useLayoutEffect } from 'react'
import { useAppStore } from '../../store'
import { CODEX_ACCOUNT_RESTART_STARTUP } from '@/lib/codex-session-restart'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { connectPanePty } from './pty-connection'
import { bindPanePtyId } from '@/lib/pane-manager/mobile-fit-overrides'
import { clearPaneTerminalError } from './terminal-error-accumulation'
import { resolveTerminalProcessExitRestartStartup } from './terminal-process-exit-restart'
import type { PaneProcessExit, PtyConnectionDeps } from './pty-connection-types'
import type { TerminalPaneCloseController } from './use-terminal-pane-close-actions'

/** Owns the restart/close actions for panes whose PTY process has exited. */
export function useTerminalPaneProcessExitActions(controller: TerminalPaneCloseController) {
  const {
    clearCodexRestartNotice,
    clearExitedPanePtyLayoutBinding,
    clearRuntimePaneTitle,
    clearTabPtyId,
    clearTerminalPaneUnread,
    clearTerminalTabUnread,
    clearWorktreeUnread,
    consumePendingCodexPaneRestart,
    cwd,
    dispatchNotification,
    executeClosePane,
    isActiveRef,
    isVisibleRef,
    markTerminalPaneUnread,
    markTerminalTabUnread,
    markWorktreeUnread,
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
    pendingCodexPaneRestartIds,
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

  const handleRestartCodexPane = useCallback(
    (
      paneId: number,
      restartStartup: PtyConnectionDeps['startup'] = CODEX_ACCOUNT_RESTART_STARTUP
    ) => {
      const manager = managerRef.current
      const pane = manager?.getPanes().find((candidate) => candidate.id === paneId)
      if (!manager || !pane) {
        return
      }
      const transport = paneTransportsRef.current.get(paneId)
      const panePtyBinding = panePtyBindingsRef.current.get(paneId)
      const existingPtyId = transport?.getPtyId()
      if (existingPtyId) {
        suppressPtyExit(existingPtyId)
        clearCodexRestartNotice(existingPtyId)
        clearTabPtyId(tabId, existingPtyId)
      }
      panePtyBinding?.dispose()
      panePtyBindingsRef.current.delete(paneId)
      syncPanePtyLayoutBinding(paneId, null)
      transport?.destroy?.()
      paneTransportsRef.current.delete(paneId)
      setCacheTimerStartedAt(makePaneKey(tabId, pane.leafId), null)
      setTerminalError(null)
      setTerminalErrorsByPaneId((current) => clearPaneTerminalError(current, paneId))
      const newPaneBinding = connectPanePty(pane, manager, {
        tabId,
        worktreeId,
        cwd,
        startup: restartStartup,
        mountFollowsTerminalPark: false,
        paneTransportsRef,
        paneMode2031Ref,
        paneKittyKeyboardModesRef,
        paneLastThemeModeRef,
        replayingPanesRef,
        isActiveRef,
        isVisibleRef,
        onPtyExitRef,
        onAgentExitedRef,
        onPtyErrorRef,
        onPtyErrorClearedRef,
        onPaneProcessDied: handlePaneProcessDied,
        onPtyRecoveryStateRef,
        clearTabPtyId,
        consumeSuppressedPtyExit: useAppStore.getState().consumeSuppressedPtyExit,
        isPtyShutdownPending: useAppStore.getState().isPtyShutdownPending,
        updateTabTitle,
        setRuntimePaneTitle,
        clearRuntimePaneTitle,
        updateTabPtyId,
        markWorktreeUnread,
        markTerminalTabUnread,
        markTerminalPaneUnread,
        clearWorktreeUnread,
        clearTerminalTabUnread,
        clearTerminalPaneUnread,
        onShowSessionRestoredBanner: showRestoredSessionBanner,
        dispatchNotification,
        setCacheTimerStartedAt,
        syncPanePtyLayoutBinding,
        clearExitedPanePtyLayoutBinding
      })
      panePtyBindingsRef.current.set(paneId, newPaneBinding)
      manager.setActivePane(paneId, { focus: true })
    },
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Preserve the pre-split dependency contract.
    [
      clearCodexRestartNotice,
      clearExitedPanePtyLayoutBinding,
      clearRuntimePaneTitle,
      clearTabPtyId,
      clearTerminalPaneUnread,
      clearTerminalTabUnread,
      clearWorktreeUnread,
      cwd,
      dispatchNotification,
      handlePaneProcessDied,
      isActiveRef,
      isVisibleRef,
      markWorktreeUnread,
      markTerminalTabUnread,
      markTerminalPaneUnread,
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
      showRestoredSessionBanner,
      suppressPtyExit,
      syncPanePtyLayoutBinding,
      tabId,
      updateTabPtyId,
      updateTabTitle,
      worktreeId
    ]
  )

  const clearPaneProcessExit = useCallback(
    (paneId: number) => {
      setPaneProcessExitsByPaneId((current) => {
        if (current[paneId] === undefined) {
          return current
        }
        const next = { ...current }
        delete next[paneId]
        return next
      })
    },
    [setPaneProcessExitsByPaneId]
  )

  const handleRestartExitedPane = useCallback(
    (processExit: PaneProcessExit) => {
      clearPaneProcessExit(processExit.paneId)
      handleRestartCodexPane(
        processExit.paneId,
        resolveTerminalProcessExitRestartStartup(processExit)
      )
    },
    [clearPaneProcessExit, handleRestartCodexPane]
  )

  const handleCloseExitedPane = useCallback(
    (paneId: number) => {
      clearPaneProcessExit(paneId)
      executeClosePane(paneId)
    },
    [clearPaneProcessExit, executeClosePane]
  )

  const panePtyLayoutBindings = savedLayout.ptyIdsByLeafId
  useLayoutEffect(() => {
    const manager = managerRef.current
    if (!manager) {
      return
    }

    // A replacement can commit tab/layout ownership while a remounted xterm
    // is still carrying the previous DOM marker. Allow an unbound transport to
    // catch up, but never let a live mismatched transport overwrite its owner.
    for (const pane of manager.getPanes()) {
      const expectedPtyId = panePtyLayoutBindings?.[pane.leafId]
      if (!expectedPtyId) {
        continue
      }
      const transport = paneTransportsRef.current.get(pane.id)
      if (transport && transport.getPtyId() && transport.getPtyId() !== expectedPtyId) {
        continue
      }
      if (pane.container.dataset.ptyId === expectedPtyId) {
        continue
      }
      bindPanePtyId(pane.id, expectedPtyId, tabId)
      pane.container.dataset.ptyId = expectedPtyId
    }
  }, [managerRef, panePtyLayoutBindings, paneTransportsRef, tabId])

  useEffect(() => {
    const manager = managerRef.current
    if (!manager) {
      return
    }
    for (const pane of manager.getPanes()) {
      const ptyId = paneTransportsRef.current.get(pane.id)?.getPtyId()
      if (!ptyId || !pendingCodexPaneRestartIds[ptyId]) {
        continue
      }
      if (consumePendingCodexPaneRestart(ptyId)) {
        handleRestartCodexPane(pane.id)
      }
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Preserve the pre-split dependency contract.
  }, [
    consumePendingCodexPaneRestart,
    handleRestartCodexPane,
    panePtyLayoutBindings,
    pendingCodexPaneRestartIds
  ])

  return { handleRestartExitedPane, handleCloseExitedPane }
}

export type TerminalPaneProcessExitController = ReturnType<typeof useTerminalPaneProcessExitActions>
