import { useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import type { OpenFile } from '@/store/slices/editor'
import { WORKTREE_OWNER_NOT_READY_ERROR, type FileContent } from './editor-panel-content-types'

const FILE_LOAD_RETRY_DELAYS_MS = [250, 1000, 2500]
// Why: a remote host can take longer than the standard backoff to finish
// connecting. Keep retrying the owner-not-ready case at a steady cadence so the
// read recovers on its own once the SSH repo hydrates (#6648).
const OWNER_NOT_READY_RETRY_LIMIT = 40
const OWNER_NOT_READY_RETRY_DELAY_MS = 750

function isOwnerNotReadyError(message: string): boolean {
  return message === WORKTREE_OWNER_NOT_READY_ERROR
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

function shouldRetryFileLoadError(message: string): boolean {
  const lower = message.toLowerCase()
  return (
    !lower.includes('access denied') &&
    !lower.includes('enoent') &&
    !lower.includes('no such file') &&
    !lower.includes('file too large')
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

  useEffect(() => {
    if (
      !activeFileLoadRetryId ||
      !activeFileLoadError ||
      !shouldRetryFileLoadError(activeFileLoadError)
    ) {
      return
    }
    const ownerNotReady = isOwnerNotReadyError(activeFileLoadError)
    const retryCount = fileLoadRetryAttemptsRef.current[activeFileLoadRetryId] ?? 0
    const retryLimit = ownerNotReady
      ? OWNER_NOT_READY_RETRY_LIMIT
      : FILE_LOAD_RETRY_DELAYS_MS.length
    if (retryCount >= retryLimit) {
      return
    }
    const delayMs = ownerNotReady
      ? OWNER_NOT_READY_RETRY_DELAY_MS
      : (FILE_LOAD_RETRY_DELAYS_MS[retryCount] ?? FILE_LOAD_RETRY_DELAYS_MS[0])
    fileLoadRetryAttemptsRef.current[activeFileLoadRetryId] = retryCount + 1
    const timeoutId = window.setTimeout(() => {
      const currentFile = openFilesRef.current.find((file) => file.id === activeFileLoadRetryId)
      if (
        !currentFile ||
        (currentFile.mode !== 'edit' && currentFile.mode !== 'markdown-preview')
      ) {
        return
      }
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
    fileLoadRetryAttemptsRef,
    loadFileContent,
    openFilesRef,
    setFileContents
  ])
}
