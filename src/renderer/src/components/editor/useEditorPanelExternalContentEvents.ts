import { useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import type { useAppStore } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import {
  getOpenFilesForExternalFileChange,
  ORCA_EDITOR_EXTERNAL_FILE_CHANGE_EVENT,
  ORCA_EDITOR_FILE_SAVED_EVENT,
  type EditorFileSavedDetail,
  type EditorPathMutationTarget
} from './editor-autosave'
import type { DiffContent, FileContent } from './editor-panel-content-types'

type EditorViewModeByFile = ReturnType<typeof useAppStore.getState>['editorViewMode']

type UseEditorPanelExternalContentEventsParams = {
  loadDiffContent: (file: OpenFile | null) => Promise<void>
  loadFileContent: (filePath: string, id: string, worktreeId?: string) => Promise<void>
  openFilesRef: MutableRefObject<OpenFile[]>
  editorViewModeRef: MutableRefObject<EditorViewModeByFile>
  setFileContents: Dispatch<SetStateAction<Record<string, FileContent>>>
  setDiffContents: Dispatch<SetStateAction<Record<string, DiffContent>>>
}

export function useEditorPanelExternalContentEvents({
  loadDiffContent,
  loadFileContent,
  openFilesRef,
  editorViewModeRef,
  setFileContents,
  setDiffContents
}: UseEditorPanelExternalContentEventsParams): void {
  useEffect(() => {
    const handler = (event: Event): void => {
      const detail = (event as CustomEvent<EditorPathMutationTarget>).detail
      if (!detail) {
        return
      }
      for (const file of getOpenFilesForExternalFileChange(openFilesRef.current, detail)) {
        if (file.mode === 'edit' || file.mode === 'markdown-preview') {
          void loadFileContent(file.filePath, file.id, file.worktreeId)
          if (editorViewModeRef.current[file.id] === 'changes') {
            void loadDiffContent(file)
          }
        } else if (
          file.mode === 'diff' &&
          file.diffSource !== 'combined-uncommitted' &&
          file.diffSource !== 'combined-branch' &&
          file.diffSource !== 'combined-commit'
        ) {
          void loadDiffContent(file)
        }
      }
    }
    window.addEventListener(ORCA_EDITOR_EXTERNAL_FILE_CHANGE_EVENT, handler as EventListener)
    return () =>
      window.removeEventListener(ORCA_EDITOR_EXTERNAL_FILE_CHANGE_EVENT, handler as EventListener)
  }, [editorViewModeRef, loadDiffContent, loadFileContent, openFilesRef])

  useEffect(() => {
    const handler = (event: Event): void => {
      const detail = (event as CustomEvent<EditorFileSavedDetail>).detail
      if (!detail) {
        return
      }
      const file = openFilesRef.current.find((openFile) => openFile.id === detail.fileId)
      if (!file) {
        return
      }
      if (file.mode === 'edit' || file.mode === 'markdown-preview') {
        setFileContents((prev) => ({
          ...prev,
          [file.id]: { content: detail.content, isBinary: false }
        }))
      }
      updateSavedPreviewTabs(openFilesRef.current, detail, setFileContents)
      if (file.mode === 'edit' || file.mode === 'markdown-preview') {
        return
      }
      setDiffContents((prev) => {
        const existing = prev[file.id]
        if (!existing || existing.kind !== 'text') {
          return prev
        }
        return { ...prev, [file.id]: { ...existing, modifiedContent: detail.content } }
      })
    }
    window.addEventListener(ORCA_EDITOR_FILE_SAVED_EVENT, handler as EventListener)
    return () => window.removeEventListener(ORCA_EDITOR_FILE_SAVED_EVENT, handler as EventListener)
  }, [openFilesRef, setDiffContents, setFileContents])
}

function updateSavedPreviewTabs(
  openFiles: OpenFile[],
  detail: EditorFileSavedDetail,
  setFileContents: Dispatch<SetStateAction<Record<string, FileContent>>>
): void {
  const previewTabs = openFiles.filter(
    (openFile) =>
      openFile.mode === 'markdown-preview' && openFile.markdownPreviewSourceFileId === detail.fileId
  )
  if (previewTabs.length === 0) {
    return
  }
  setFileContents((prev) => {
    const next = { ...prev }
    for (const previewTab of previewTabs) {
      next[previewTab.id] = { content: detail.content, isBinary: false }
    }
    return next
  })
}

export function usePruneClosedEditorContent(
  openFiles: OpenFile[],
  fileLoadRetryAttemptsRef: MutableRefObject<Record<string, number>>,
  setFileContents: Dispatch<SetStateAction<Record<string, FileContent>>>,
  setDiffContents: Dispatch<SetStateAction<Record<string, DiffContent>>>
): void {
  useEffect(() => {
    const openIds = new Set(openFiles.map((f) => f.id))
    for (const fileId of Object.keys(fileLoadRetryAttemptsRef.current)) {
      if (!openIds.has(fileId)) {
        delete fileLoadRetryAttemptsRef.current[fileId]
      }
    }
    setFileContents((prev) =>
      Object.fromEntries(Object.entries(prev).filter(([key]) => openIds.has(key)))
    )
    setDiffContents((prev) =>
      Object.fromEntries(Object.entries(prev).filter(([key]) => openIds.has(key)))
    )
  }, [fileLoadRetryAttemptsRef, openFiles, setDiffContents, setFileContents])
}
