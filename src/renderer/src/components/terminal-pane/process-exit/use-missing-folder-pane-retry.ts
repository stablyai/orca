import { useEffect, useRef } from 'react'
import { installWindowVisibilityInterval } from '@/lib/window-activity/window-visibility-interval'
import { readMissingWorkingDirectory } from '../../../../../shared/terminal/pty/lifecycle/missing-working-directory-message'
import type { TerminalErrorsByPaneId } from '../errors/terminal-error-accumulation'
import type { usePaneProcessRestart } from './use-pane-process-restart'
import type { TerminalPaneFoundation } from '../controller/use-terminal-pane-foundation'

const FOLDER_POLL_MS = 3_000

function missingFolderByPane(errors: TerminalErrorsByPaneId): Map<number, string> {
  const folders = new Map<number, string>()
  for (const [paneId, paneErrors] of Object.entries(errors)) {
    const folder = paneErrors
      .map((error) => readMissingWorkingDirectory(error.message))
      .findLast((path) => path !== null)
    if (folder) {
      folders.set(Number(paneId), folder)
    }
  }
  return folders
}

/** A pane refused for a missing folder (an unmounted volume) starts again once the folder is back, even if its error toast was dismissed. */
export function useMissingFolderPaneRetry({
  terminalErrorsByPaneId,
  paneOnClient,
  paneTransportsRef,
  handleRestartPane
}: {
  terminalErrorsByPaneId: TerminalErrorsByPaneId
  /** False for SSH, runtime or not-yet-known hosts: this client cannot see their folders. */
  paneOnClient: boolean
  paneTransportsRef: TerminalPaneFoundation['paneTransportsRef']
  handleRestartPane: ReturnType<typeof usePaneProcessRestart>['handleRestartPane']
}): void {
  const waitingRef = useRef(new Map<number, string>())
  const stopPollingRef = useRef<(() => void) | null>(null)
  const restartRef = useRef(handleRestartPane)
  useEffect(() => {
    restartRef.current = handleRestartPane
  }, [handleRestartPane])

  useEffect(() => {
    const waiting = waitingRef.current
    if (!paneOnClient) {
      return
    }
    for (const [paneId, folder] of missingFolderByPane(terminalErrorsByPaneId)) {
      waiting.set(paneId, folder)
    }
    if (waiting.size === 0 || stopPollingRef.current) {
      return
    }
    let probing = false
    stopPollingRef.current = installWindowVisibilityInterval({
      intervalMs: FOLDER_POLL_MS,
      slowWhileUnfocused: true,
      run: () => {
        if (probing) {
          return
        }
        probing = true
        void Promise.all(
          [...waiting].map(async ([paneId, folder]) => {
            const exists = await window.api.shell.pathExists(folder).catch(() => false)
            if (!exists || !waiting.delete(paneId)) {
              return
            }
            // Why: a pane the user already restarted owns a live shell this must not replace.
            if (paneTransportsRef.current.get(paneId)?.getPtyId()) {
              return
            }
            try {
              restartRef.current(paneId, null, { focus: false })
            } catch {
              // Why: a failed restart already cleared the pane's error, so keep waiting rather than leave it dead.
              waiting.set(paneId, folder)
            }
          })
        ).finally(() => {
          probing = false
          if (waiting.size === 0) {
            stopPollingRef.current?.()
            stopPollingRef.current = null
          }
        })
      }
    })
  }, [terminalErrorsByPaneId, paneOnClient, paneTransportsRef])

  useEffect(() => {
    const waiting = waitingRef.current
    return () => {
      stopPollingRef.current?.()
      stopPollingRef.current = null
      waiting.clear()
    }
  }, [])
}
