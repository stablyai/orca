import { useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import type { OpenFile } from '@/store/slices/editor'
import type { FileContent } from './editor-panel-content-types'

const FILE_LOAD_RETRY_DELAYS_MS = [250, 1000, 2500]

type UseEditorPanelFileLoadRetryParams = {
  activeFile: OpenFile | null
  fileContents: Record<string, FileContent>
  fileLoadRetryAttemptsRef: MutableRefObject<Record<string, number>>
  loadFileContent: (filePath: string, id: string, worktreeId?: string) => Promise<void>
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
    const retryCount = fileLoadRetryAttemptsRef.current[activeFileLoadRetryId] ?? 0
    if (retryCount >= FILE_LOAD_RETRY_DELAYS_MS.length) {
      return
    }
    const delayMs = FILE_LOAD_RETRY_DELAYS_MS[retryCount] ?? FILE_LOAD_RETRY_DELAYS_MS[0]
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
      void loadFileContent(currentFile.filePath, currentFile.id, currentFile.worktreeId)
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
