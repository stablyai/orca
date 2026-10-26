import { useCallback, useEffect, useLayoutEffect } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '../../store'
import { buildPaneAccountRestartStartup } from '@/lib/agent-account-restart-startup'
import {
  isAccountRestartReady,
  selectReadyAccountRestartPtyIds
} from './pane-account-restart-readiness'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { connectPanePty } from './pty-connection'
import { bindPanePtyId } from '@/lib/pane-manager/mobile-fit-overrides'
import { releasePaneTransportForRestart } from './pane-restart-transport-handoff'
import { clearPaneTerminalError } from './terminal-error-accumulation'
import { resolveTerminalProcessExitRestartStartup } from './terminal-process-exit-restart'
import type { PaneProcessExit, PtyConnectionDeps } from './pty-connection-types'
import type { TerminalPaneCloseController } from './use-terminal-pane-close-actions'
import type { AccountRestartAgent } from '@/store/terminals/terminal-contracts'

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

  const buildAccountRestartStartup = useCallback(
    (agent: AccountRestartAgent, leafId: string) =>
      buildPaneAccountRestartStartup(agent, {
        tabId,
        worktreeId,
        leafId,
        shellOverride: useAppStore
          .getState()
          .tabsByWorktree[worktreeId]?.find((tab) => tab.id === tabId)?.shellOverride
      }),
    [tabId, worktreeId]
  )

  const handleRestartPane = useCallback(
    (paneId: number, startup: PtyConnectionDeps['startup'], options: { focus: boolean }) => {
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
      const replacesPtyId = releasePaneTransportForRestart(transport)
      paneTransportsRef.current.delete(paneId)
      setCacheTimerStartedAt(makePaneKey(tabId, pane.leafId), null)
      setTerminalError(null)
      setTerminalErrorsByPaneId((current) => clearPaneTerminalError(current, paneId))
      const newPaneBinding = connectPanePty(pane, manager, {
        tabId,
        worktreeId,
        cwd,
        startup,
        ...(replacesPtyId ? { replacesPtyId } : {}),
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
        markTerminalBell,
        onShowSessionRestoredBanner: showRestoredSessionBanner,
        dispatchNotification,
        setCacheTimerStartedAt,
        syncPanePtyLayoutBinding,
        clearExitedPanePtyLayoutBinding
      })
      panePtyBindingsRef.current.set(paneId, newPaneBinding)
      if (options.focus) {
        manager.setActivePane(paneId, { focus: true })
      }
    },
    [
      clearCodexRestartNotice,
      clearExitedPanePtyLayoutBinding,
      clearRuntimePaneTitle,
      clearTabPtyId,
      cwd,
      dispatchNotification,
      handlePaneProcessDied,
      isActiveRef,
      isVisibleRef,
      markTerminalBell,
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
      worktreeId,
      setTerminalErrorsByPaneId
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
      // Why no agent fallback: a null startup means a plain shell; account switches restart via their own path.
      handleRestartPane(processExit.paneId, resolveTerminalProcessExitRestartStartup(processExit), {
        focus: true
      })
    },
    [clearPaneProcessExit, handleRestartPane]
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

    // Unbound remounts may catch up to replacement ownership; a live mismatched transport must never overwrite it.
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

  // Why primitive ids: unrelated status updates stay shallow-equal and skip this pane.
  const readyRestartPtyIds = useAppStore(
    useShallow((state) => selectReadyAccountRestartPtyIds(state, tabId))
  )
  useEffect(() => {
    const manager = managerRef.current
    if (!manager || readyRestartPtyIds.length === 0) {
      return
    }
    for (const pane of manager.getPanes()) {
      const ptyId = paneTransportsRef.current.get(pane.id)?.getPtyId()
      if (
        !ptyId ||
        !readyRestartPtyIds.includes(ptyId) ||
        !isAccountRestartReady(useAppStore.getState(), tabId, pane.leafId, ptyId)
      ) {
        continue
      }
      const agent = consumePendingPaneAccountRestart(ptyId)
      const startup = agent ? buildAccountRestartStartup(agent, pane.leafId) : null
      if (agent && startup) {
        // Why: one Claude switch restarts many panes at once; none was the one the user clicked.
        handleRestartPane(pane.id, startup, { focus: agent === 'codex' })
      }
    }
  }, [
    buildAccountRestartStartup,
    consumePendingPaneAccountRestart,
    handleRestartPane,
    panePtyLayoutBindings,
    readyRestartPtyIds,
    managerRef,
    paneTransportsRef,
    tabId
  ])

  return { handleRestartExitedPane, handleCloseExitedPane }
}

export type TerminalPaneProcessExitController = ReturnType<typeof useTerminalPaneProcessExitActions>
