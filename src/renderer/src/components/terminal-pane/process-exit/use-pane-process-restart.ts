import { useCallback } from 'react'
import { useAppStore } from '../../../store'
import { makePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'
import { connectPanePty } from '../pty-connection/connect-pane-pty'
import { RESET_WIN32_INPUT_MODE } from '../../../../../shared/terminal/protocol/input-modes/terminal-mode-reset-profiles'
import { releasePaneTransportForRestart } from './pane-restart-transport-handoff'
import { holdPaneResumeInPlace } from '../session-restore/spawn-deferral/pane-spawn-deferral-registry'
import { clearPaneTerminalError } from '../errors/terminal-error-accumulation'
import type { PtyConnectionDeps } from '../pty-connection/pty-connection-deps'
import type { TerminalPaneCloseController } from '../layout/close/use-terminal-pane-close-actions'
import { clearRetainedInlineScrollback } from '../snapshots/terminal-scrollback-ref-hydration'

export function usePaneProcessRestart({
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
}: Pick<
  TerminalPaneCloseController,
  | 'clearCodexRestartNotice'
  | 'clearExitedPanePtyLayoutBinding'
  | 'clearRuntimePaneTitle'
  | 'clearTabPtyId'
  | 'cwd'
  | 'dispatchNotification'
  | 'initialLayoutRef'
  | 'isActiveRef'
  | 'isVisibleRef'
  | 'markTerminalBell'
  | 'handlePaneProcessDied'
  | 'managerRef'
  | 'onAgentExitedRef'
  | 'onPtyErrorClearedRef'
  | 'onPtyErrorRef'
  | 'onPtyExitRef'
  | 'onPtyRecoveryStateRef'
  | 'paneKittyKeyboardModesRef'
  | 'paneLastThemeModeRef'
  | 'paneMode2031Ref'
  | 'panePtyBindingsRef'
  | 'paneTransportsRef'
  | 'replayingPanesRef'
  | 'setCacheTimerStartedAt'
  | 'setRuntimePaneTitle'
  | 'setTerminalError'
  | 'setTerminalErrorsByPaneId'
  | 'showRestoredSessionBanner'
  | 'suppressPtyExit'
  | 'syncPanePtyLayoutBinding'
  | 'tabId'
  | 'updateTabPtyId'
  | 'updateTabTitle'
  | 'worktreeId'
>) {
  const handleRestartPane = useCallback(
    (paneId: number, startup: PtyConnectionDeps['startup'], options: { focus: boolean }) => {
      const manager = managerRef.current
      const pane = manager?.getPanes().find((candidate) => candidate.id === paneId)
      if (!manager || !pane) {
        return
      }
      // Activation must not fork the retained conversation while its replacement has no PTY.
      const releaseResumeInPlace = holdPaneResumeInPlace(
        makePaneKey(tabId, pane.leafId),
        () => true
      )
      try {
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
        // The replacement process re-requests win32 input mode itself if it wants it.
        paneKittyKeyboardModesRef?.current.get(paneId)?.scan(RESET_WIN32_INPUT_MODE)
        setCacheTimerStartedAt(makePaneKey(tabId, pane.leafId), null)
        setTerminalError(null)
        setTerminalErrorsByPaneId((current) => clearPaneTerminalError(current, paneId))
        const newPaneBinding = connectPanePty(pane, manager, {
          tabId,
          worktreeId,
          cwd,
          startup,
          releaseResumeInPlace,
          ...(replacesPtyId ? { replacesPtyId } : {}),
          mountFollowsTerminalPark: false,
          invalidateRetainedInlineScrollback: (leafId) => {
            initialLayoutRef.current = clearRetainedInlineScrollback(
              initialLayoutRef.current,
              leafId
            )
          },
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
      } catch (error) {
        releaseResumeInPlace()
        throw error
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
      initialLayoutRef,
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
  return { handleRestartPane }
}
