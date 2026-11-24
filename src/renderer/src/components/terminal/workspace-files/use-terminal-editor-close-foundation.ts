import { useCallback, useRef, useState } from 'react'
import { CLOSE_DIALOG_DEBOUNCE_MS } from '../workbench/terminal-workspace-model'
import {
  assessWindowCloseRunningWork,
  type WindowCloseRunningWork
} from '../tab-lifecycle/window-close-running-work'
import type { TerminalWorkspaceProjectionController } from '../workbench/use-terminal-workspace-projection'
import {
  confirmInteractiveWindowClose,
  isWindowCloseAttemptCurrent,
  type WindowCloseAttempt
} from '../../../app-shell/shutdown/window-close-request-coordinator'

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
  const [windowCloseDialog, setWindowCloseDialog] = useState<{
    kind: Exclude<WindowCloseRunningWork['kind'], 'none'>
    attempt: WindowCloseAttempt
  } | null>(null)
  const windowCloseAfterDirtyRef = useRef<WindowCloseAttempt | null>(null)

  const proceedToNativeWindowClose = useCallback((attempt: WindowCloseAttempt) => {
    void assessWindowCloseRunningWork(attempt)
      .then((runningWork) => {
        if (!isWindowCloseAttemptCurrent(attempt)) {
          return
        }
        if (runningWork.kind === 'none') {
          void confirmInteractiveWindowClose(attempt)
          return
        }
        setWindowCloseDialog({ kind: runningWork.kind, attempt })
      })
      // Assessment exceptions prove neither live nor exited work; fall through so an unexpected store error cannot trap the window.
      .catch(() => {
        void confirmInteractiveWindowClose(attempt)
      })
  }, [])

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
    windowCloseDialog,
    setWindowCloseDialog,
    windowCloseAfterDirtyRef,
    proceedToNativeWindowClose
  }
}

export type TerminalEditorCloseFoundation = TerminalWorkspaceProjectionController &
  ReturnType<typeof useTerminalEditorCloseFoundation>
