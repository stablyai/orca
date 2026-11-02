import { useCallback, useRef, useState } from 'react'
import { CLOSE_DIALOG_DEBOUNCE_MS } from './terminal-workspace-model'
import {
  assessWindowCloseRunningWork,
  type WindowCloseRunningWork
} from './terminal/window-close-running-work'
import type { TerminalWorkspaceProjectionController } from './use-terminal-workspace-projection'
import { runWithWindowCloseCheckpointScope } from './window-close-request-coordinator'
import { showShutdownCheckpointFailureToast } from '@/lib/shutdown-checkpoint-failure-toast'

export function useTerminalEditorCloseFoundation(
  controller: TerminalWorkspaceProjectionController
) {
  const { openFiles } = controller
  const [saveDialogFileId, setSaveDialogFileId] = useState<string | null>(null)
  const saveDialogFile = saveDialogFileId
    ? openFiles.find((file) => file.id === saveDialogFileId)
    : null
  const pendingEditorCloseQueueRef = useRef<string[]>([])
  // Why: a close request can carry what to do once its file actually closes; cancel drops it.
  const closedReactionsRef = useRef(new Map<string, () => void>())
  const inFlightSaveFileIdRef = useRef<string | null>(null)
  const isClosingRef = useRef(false)
  const closeDialogDebounceTimersRef = useRef<Set<number>>(new Set())
  const releaseCloseDialogGuardAfterDebounce = useCallback(() => {
    const timer = window.setTimeout(() => {
      closeDialogDebounceTimersRef.current.delete(timer)
      isClosingRef.current = false
    }, CLOSE_DIALOG_DEBOUNCE_MS)
    closeDialogDebounceTimersRef.current.add(timer)
  }, [])
  const [windowCloseDialogOpen, setWindowCloseDialogOpen] = useState(false)
  // Distinguish reported live work from unreachable hosts; loss of contact cannot prove running processes (ssh-execution-boundary.md).
  const [windowCloseDialogKind, setWindowCloseDialogKind] =
    useState<Exclude<WindowCloseRunningWork['kind'], 'none'>>('running')
  const windowCloseAfterDirtyRef = useRef<{ isQuitting: boolean } | null>(null)

  const confirmNativeWindowClose = useCallback(() => {
    // Capture only after every close guard commits so canceled process prompts cannot consume App’s unload guard.
    const accepted = runWithWindowCloseCheckpointScope(() =>
      window.dispatchEvent(new Event('beforeunload', { cancelable: true }))
    )
    if (!accepted) {
      // Report checkpoint-vetoed quits instead of silently trapping the window (#15352); dirty-file vetoes provide no reason.
      showShutdownCheckpointFailureToast()
      return
    }
    window.api.ui.confirmWindowClose()
  }, [])

  const proceedToNativeWindowClose = useCallback(
    (isQuitting: boolean) => {
      void assessWindowCloseRunningWork({ isQuitting })
        .then((runningWork) => {
          if (runningWork.kind === 'none') {
            confirmNativeWindowClose()
            return
          }
          setWindowCloseDialogKind(runningWork.kind)
          setWindowCloseDialogOpen(true)
        })
        // Assessment exceptions prove neither live nor exited work; fall through so an unexpected store error cannot trap the window.
        .catch(() => {
          confirmNativeWindowClose()
        })
    },
    [confirmNativeWindowClose]
  )

  return {
    saveDialogFileId,
    setSaveDialogFileId,
    saveDialogFile,
    pendingEditorCloseQueueRef,
    closedReactionsRef,
    inFlightSaveFileIdRef,
    isClosingRef,
    closeDialogDebounceTimersRef,
    releaseCloseDialogGuardAfterDebounce,
    windowCloseDialogOpen,
    setWindowCloseDialogOpen,
    windowCloseDialogKind,
    windowCloseAfterDirtyRef,
    confirmNativeWindowClose,
    proceedToNativeWindowClose
  }
}

export type TerminalEditorCloseFoundation = TerminalWorkspaceProjectionController &
  ReturnType<typeof useTerminalEditorCloseFoundation>
