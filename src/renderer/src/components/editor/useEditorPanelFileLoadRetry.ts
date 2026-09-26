import { useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import type { OpenFile } from '@/store/slices/editor'
import { hasRuntimeRpcErrorCode } from '../../../../shared/runtime-rpc-error-code'
import {
  FILE_TOO_LARGE_CODE,
  WORKTREE_HOST_SELECTOR_NOT_FOUND_CODE,
  WORKTREE_HOST_UNRESOLVED_CODE,
  WORKTREE_HOST_UNRESOLVED_ERROR,
  WORKTREE_OWNER_NOT_READY_ERROR,
  WORKTREE_OWNER_UNREACHABLE_ERROR,
  type FileContent
} from './editor-panel-content-types'

export const FILE_LOAD_RETRY_DELAYS_MS = [250, 1000, 2500]
// Why: a remote host can take a while to finish connecting. The owner-not-ready
// check is a pure local store read (it throws before any network call until the
// SSH repo hydrates), so poll it at a steady cadence — but cap the wait so a
// host that never connects ends in a truthful terminal message instead of
// retrying forever. ~2 min covers any realistic connect; Retry re-arms it (#6648).
export const OWNER_NOT_READY_RETRY_DELAY_MS = 750
export const OWNER_NOT_READY_RETRY_LIMIT = 160

function isOwnerNotReadyError(message: string): boolean {
  return message === WORKTREE_OWNER_NOT_READY_ERROR
}

// Why the shared matcher: the token may arrive on `.code` with prose on the message, as
// the bare message, or transport-wrapped ("…: selector_not_found"); a message compare
// alone would strand the first shape on raw text with no way out (#21041).
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
  // Terminal: a retry budget is spent; only an explicit Retry should restart it,
  // never the automatic backoff.
  if (
    message === WORKTREE_OWNER_UNREACHABLE_ERROR ||
    code === WORKTREE_HOST_UNRESOLVED_CODE ||
    code === FILE_TOO_LARGE_CODE
  ) {
    return false
  }
  const lower = message.toLowerCase()
  return (
    !lower.includes('access denied') &&
    !lower.includes('enoent') &&
    !lower.includes('no such file') &&
    !lower.includes('file too large') &&
    !lower.includes(FILE_TOO_LARGE_CODE)
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

  useEffect(() => {
    if (
      !activeFileLoadRetryId ||
      !activeFileLoadError ||
      !shouldRetryFileLoadError(activeFileLoadError, activeFileLoadErrorCode)
    ) {
      return
    }
    const ownerNotReady = isOwnerNotReadyError(activeFileLoadError)
    const retryCount = fileLoadRetryAttemptsRef.current[activeFileLoadRetryId] ?? 0
    const retryLimit = ownerNotReady
      ? OWNER_NOT_READY_RETRY_LIMIT
      : FILE_LOAD_RETRY_DELAYS_MS.length
    if (retryCount >= retryLimit) {
      // Why: the remote host never finished connecting (#6648), or its worktree
      // resolver still cannot place the workspace (#21041). Replace the transient
      // text with a truthful terminal message so it does not look like it is still
      // retrying; Retry starts a fresh budget. selector_not_found is UNKNOWN, not
      // absence, so the tab stays open: closing is the user's call, which is also
      // what keeps an unsaved draft from being discarded on a resolver blip.
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
    const timeoutId = window.setTimeout(() => {
      const currentFile = openFilesRef.current.find((file) => file.id === activeFileLoadRetryId)
      if (
        !currentFile ||
        (currentFile.mode !== 'edit' && currentFile.mode !== 'markdown-preview')
      ) {
        return
      }
      fileLoadRetryAttemptsRef.current[activeFileLoadRetryId] = retryCount + 1
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
    }, delayMs)
    return () => window.clearTimeout(timeoutId)
  }, [
    activeFileLoadRetryId,
    activeFileLoadError,
    activeFileLoadErrorCode,
    fileLoadRetryAttemptsRef,
    loadFileContent,
    openFilesRef,
    setFileContents
  ])
}
