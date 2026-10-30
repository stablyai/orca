import { useEffect, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import type { OpenFile } from '@/store/slices/editor'
import { useWorktreeHostConnection } from '@/lib/worktree-host-connection-phase'
import { displayIpcErrorMessage } from '@/lib/ipc-error'
import { hasRuntimeRpcErrorCode } from '../../../../shared/runtime-rpc-error-code'
import { isFileTooLargeMessage } from '../../../../shared/file-write-disk-precondition'
import {
  WORKTREE_HOST_SELECTOR_NOT_FOUND_CODE,
  WORKTREE_HOST_UNRESOLVED_CODE,
  WORKTREE_HOST_UNRESOLVED_ERROR,
  WORKTREE_OWNER_NOT_READY_ERROR,
  WORKTREE_OWNER_UNREACHABLE_ERROR,
  type FileContent
} from './editor-panel-content-types'

export const FILE_LOAD_RETRY_DELAYS_MS = [250, 1000, 2500]
// Poll unresolved local owner state without network calls; bound the wait to two minutes, then require explicit Retry.
export const OWNER_NOT_READY_RETRY_DELAY_MS = 750
export const OWNER_NOT_READY_RETRY_LIMIT = 160

function isOwnerNotReadyError(message: string): boolean {
  return message === WORKTREE_OWNER_NOT_READY_ERROR
}

// Shared matching accepts codes on code/message fields or transport-wrapped text; message equality misses valid host failures.
export function isHostSelectorNotFoundError(
  failure: Pick<FileContent, 'loadError' | 'loadErrorCode'>
): boolean {
  return hasRuntimeRpcErrorCode(
    { code: failure.loadErrorCode, message: failure.loadError },
    WORKTREE_HOST_SELECTOR_NOT_FOUND_CODE
  )
}

type UseEditorPanelFileLoadRetryParams = {
  activeFile: OpenFile | null
  fileContents: Record<string, FileContent>
  fileLoadRetryAttemptsRef: MutableRefObject<Record<string, number>>
  loadFileContent: (
    filePath: string,
    id: string,
    worktreeId?: string,
    relativePath?: string
  ) => Promise<void>
  openFilesRef: MutableRefObject<OpenFile[]>
  setFileContents: Dispatch<SetStateAction<Record<string, FileContent>>>
}

export function shouldRetryFileLoadError(message: string, code?: string): boolean {
  // Automatic backoff must not restart an exhausted budget.
  if (message === WORKTREE_OWNER_UNREACHABLE_ERROR || code === WORKTREE_HOST_UNRESOLVED_CODE) {
    return false
  }
  const lower = message.toLowerCase()
  return (
    !lower.includes('access denied') &&
    !lower.includes('enoent') &&
    !lower.includes('no such file') &&
    !isFileTooLargeMessage(displayIpcErrorMessage(message) ?? message)
  )
}

export function useEditorPanelFileLoadRetry({
  activeFile,
  fileContents,
  fileLoadRetryAttemptsRef,
  loadFileContent,
  openFilesRef,
  setFileContents
}: UseEditorPanelFileLoadRetryParams): void {
  const activeFileLoadRetryId = activeFile?.id ?? null
  const activeFileLoadError = activeFileLoadRetryId
    ? fileContents[activeFileLoadRetryId]?.loadError
    : undefined
  const activeFileLoadErrorCode = activeFileLoadRetryId
    ? fileContents[activeFileLoadRetryId]?.loadErrorCode
    : undefined
  const hostConnection = useWorktreeHostConnection(activeFile?.worktreeId ?? null)
  const hostTargetId = hostConnection.targetId
  const hostConnecting = hostConnection.phase === 'connecting'
  const connectedHostEpoch = hostConnection.connectedEpoch
  const seenHostRef = useRef({ targetId: hostTargetId, connectedEpoch: connectedHostEpoch })

  useEffect(() => {
    // Why the same target: switching to a file on another host is not that host connecting.
    const hostJustConnected =
      connectedHostEpoch !== null &&
      seenHostRef.current.targetId === hostTargetId &&
      seenHostRef.current.connectedEpoch !== connectedHostEpoch
    seenHostRef.current = { targetId: hostTargetId, connectedEpoch: connectedHostEpoch }
    if (!activeFileLoadRetryId || !activeFileLoadError) {
      return
    }
    const reload = (nextRetryCount: number): void => {
      const currentFile = openFilesRef.current.find((file) => file.id === activeFileLoadRetryId)
      if (
        !currentFile ||
        (currentFile.mode !== 'edit' && currentFile.mode !== 'markdown-preview')
      ) {
        return
      }
      fileLoadRetryAttemptsRef.current[activeFileLoadRetryId] = nextRetryCount
      setFileContents((prev) => {
        if (prev[currentFile.id]?.loadError !== activeFileLoadError) {
          return prev
        }
        const next = { ...prev }
        delete next[currentFile.id]
        return next
      })
      void loadFileContent(
        currentFile.filePath,
        currentFile.id,
        currentFile.worktreeId,
        currentFile.relativePath
      )
    }
    // Why: the connected transition below re-arms the read, so waiting spends no budget.
    if (hostConnecting) {
      return
    }
    // A fresh connection can recover failed reads even after their earlier retry budget expired.
    if (
      hostJustConnected &&
      (activeFileLoadError === WORKTREE_OWNER_UNREACHABLE_ERROR ||
        shouldRetryFileLoadError(activeFileLoadError, activeFileLoadErrorCode))
    ) {
      reload(0)
      return
    }
    if (!shouldRetryFileLoadError(activeFileLoadError, activeFileLoadErrorCode)) {
      return
    }
    const ownerNotReady = isOwnerNotReadyError(activeFileLoadError)
    const retryCount = fileLoadRetryAttemptsRef.current[activeFileLoadRetryId] ?? 0
    const retryLimit = ownerNotReady
      ? OWNER_NOT_READY_RETRY_LIMIT
      : FILE_LOAD_RETRY_DELAYS_MS.length
    if (retryCount >= retryLimit) {
      // End exhausted retries without closing: unresolved ownership does not prove deletion and must preserve drafts until explicit Retry/close.
      const terminalFailure: Pick<FileContent, 'loadError' | 'loadErrorCode'> | null = ownerNotReady
        ? { loadError: WORKTREE_OWNER_UNREACHABLE_ERROR }
        : isHostSelectorNotFoundError({
              loadError: activeFileLoadError,
              loadErrorCode: activeFileLoadErrorCode
            })
          ? {
              loadError: WORKTREE_HOST_UNRESOLVED_ERROR,
              loadErrorCode: WORKTREE_HOST_UNRESOLVED_CODE
            }
          : null
      if (terminalFailure) {
        setFileContents((prev) => {
          if (prev[activeFileLoadRetryId]?.loadError !== activeFileLoadError) {
            return prev
          }
          return {
            ...prev,
            [activeFileLoadRetryId]: { content: '', isBinary: false, ...terminalFailure }
          }
        })
      }
      return
    }
    const delayMs = ownerNotReady
      ? OWNER_NOT_READY_RETRY_DELAY_MS
      : (FILE_LOAD_RETRY_DELAYS_MS[retryCount] ?? FILE_LOAD_RETRY_DELAYS_MS[0])
    const timeoutId = window.setTimeout(() => reload(retryCount + 1), delayMs)
    return () => window.clearTimeout(timeoutId)
  }, [
    activeFileLoadRetryId,
    activeFileLoadError,
    activeFileLoadErrorCode,
    connectedHostEpoch,
    hostConnecting,
    hostTargetId,
    fileLoadRetryAttemptsRef,
    loadFileContent,
    openFilesRef,
    setFileContents
  ])
}
