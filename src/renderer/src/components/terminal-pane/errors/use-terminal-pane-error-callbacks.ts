import { useCallback, useRef } from 'react'
import { isTerminalSessionStateSaveFailure } from '../../../../../shared/workspace-session/terminal-session-state-save-failure'
import { AGENT_LAUNCH_PANE_REFUSED_CODE } from '../../../../../shared/agent-launch/contracts/agent-launch-pane-verdict'
import { appendPaneTerminalError, clearPaneTerminalError } from './terminal-error-accumulation'
import { stripSshReconnectOwnedErrorLines } from './terminal-error-display'
import { releaseCodexAccountRestartRefusal } from '../account-restart/codex-account-restart-stop'
import type { TerminalPaneFoundation } from '../controller/use-terminal-pane-foundation'

export function useTerminalPaneErrorCallbacks({
  managerRef,
  paneTransportsRef,
  setSessionStateSaveFailureMessage,
  setTerminalError,
  setTerminalErrorsByPaneId,
  sshReconnectOwnsTerminalErrorsRef,
  tabId,
  worktreeId
}: Pick<
  TerminalPaneFoundation,
  | 'managerRef'
  | 'paneTransportsRef'
  | 'setSessionStateSaveFailureMessage'
  | 'setTerminalError'
  | 'setTerminalErrorsByPaneId'
  | 'sshReconnectOwnsTerminalErrorsRef'
  | 'tabId'
  | 'worktreeId'
>) {
  const onPtyErrorRef = useRef((paneId: number, message: string) => {
    if (message.includes(AGENT_LAUNCH_PANE_REFUSED_CODE)) {
      // A launch pane's verdict reached the tab typed; its notice shows it, not an error.
      return
    }
    if (isTerminalSessionStateSaveFailure(message)) {
      setTerminalError(null)
      setTerminalErrorsByPaneId({})
      setSessionStateSaveFailureMessage(message)
      return
    }
    const visibleMessage = sshReconnectOwnsTerminalErrorsRef.current
      ? stripSshReconnectOwnedErrorLines(message)
      : message
    if (visibleMessage !== null) {
      setTerminalErrorsByPaneId((current) =>
        appendPaneTerminalError(current, paneId, visibleMessage)
      )
    }
  })
  const onPtyErrorClearedRef = useRef((paneId: number, message?: string) => {
    setTerminalErrorsByPaneId((current) => clearPaneTerminalError(current, paneId, message))
  })
  const dismissTerminalError = useCallback(() => {
    const pane = managerRef.current?.getActivePane() ?? null
    const paneId = pane?.id ?? null
    setTerminalError(null)
    if (pane && paneId !== null) {
      setTerminalErrorsByPaneId((current) => {
        // Dismissing a failed account-restart resume lets the pane start normally again (idempotent).
        releaseCodexAccountRestartRefusal(
          (current[paneId] ?? []).map((entry) => entry.message).join('\n'),
          worktreeId,
          tabId,
          pane.leafId
        )
        return clearPaneTerminalError(current, paneId)
      })
      paneTransportsRef.current.get(paneId)?.notifyErrorSurfaceDismissed?.()
    }
  }, [
    managerRef,
    paneTransportsRef,
    setTerminalError,
    setTerminalErrorsByPaneId,
    tabId,
    worktreeId
  ])
  return { onPtyErrorRef, onPtyErrorClearedRef, dismissTerminalError }
}
