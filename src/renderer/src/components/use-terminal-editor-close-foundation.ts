import { useCallback, useRef, useState } from 'react'
import { useAppStore } from '../store'
import { getConnectionId } from '../lib/connection-context'
import { isRemoteRuntimePtyId } from '@/runtime/runtime-terminal-inspection'
import { CLOSE_DIALOG_DEBOUNCE_MS } from './terminal-workspace-model'
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
  const windowCloseAfterDirtyRef = useRef<{ isQuitting: boolean } | null>(null)

  const confirmNativeWindowClose = useCallback(() => {
    // Why: capture only after every close guard has committed. A canceled child-
    // process prompt must not consume App's synthetic/native unload guard.
    const accepted = runWithWindowCloseCheckpointScope(() =>
      window.dispatchEvent(new Event('beforeunload', { cancelable: true }))
    )
    if (!accepted) {
      // Why: a checkpoint-vetoed quit used to die here with no dialog and no log,
      // leaving SIGKILL as the only exit (#15352). Dirty-file vetoes publish no reason.
      showShutdownCheckpointFailureToast()
      return
    }
    window.api.ui.confirmWindowClose()
  }, [])

  const proceedToNativeWindowClose = useCallback(
    (isQuitting: boolean) => {
      if (!isQuitting) {
        const state = useAppStore.getState()
        const localPtyIds = Object.entries(state.tabsByWorktree).flatMap(
          ([worktreeId, worktreeTabs]) => {
            const connectionId = getConnectionId(worktreeId)
            if (connectionId !== null) {
              return []
            }
            return worktreeTabs
              .flatMap((tab) => state.ptyIdsByTabId[tab.id] ?? [])
              .filter((ptyId) => !isRemoteRuntimePtyId(ptyId))
          }
        )
        if (localPtyIds.length > 0) {
          void Promise.all(localPtyIds.map((id) => window.api.pty.hasChildProcesses(id))).then(
            (results) => {
              if (results.some(Boolean)) {
                setWindowCloseDialogOpen(true)
              } else {
                confirmNativeWindowClose()
              }
            }
          )
          return
        }
      }
      confirmNativeWindowClose()
    },
    [confirmNativeWindowClose]
  )

  return {
    saveDialogFileId,
    setSaveDialogFileId,
    saveDialogFile,
    pendingEditorCloseQueueRef,
    inFlightSaveFileIdRef,
    isClosingRef,
    closeDialogDebounceTimersRef,
    releaseCloseDialogGuardAfterDebounce,
    windowCloseDialogOpen,
    setWindowCloseDialogOpen,
    windowCloseAfterDirtyRef,
    confirmNativeWindowClose,
    proceedToNativeWindowClose
  }
}

export type TerminalEditorCloseFoundation = TerminalWorkspaceProjectionController &
  ReturnType<typeof useTerminalEditorCloseFoundation>
