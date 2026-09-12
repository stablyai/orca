import { useEffect, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
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
import { isReloadableSingleFileDiffTab } from './editor-panel-diff-reload'

type EditorViewModeByFile = ReturnType<typeof useAppStore.getState>['editorViewMode']

export type EditorPanelContentLoadOptions = {
  force?: boolean
  externalEventGeneration?: number
}

type UseEditorPanelExternalContentEventsParams = {
  activeContentFileIdRef: MutableRefObject<string | null>
  invalidateContent: (fileIds: string[]) => void
  invalidateDiffContent: (fileIds: string[]) => void
  isVisibleRef: MutableRefObject<boolean>
  loadDiffContent: (file: OpenFile | null, options?: EditorPanelContentLoadOptions) => Promise<void>
  loadFileContent: (
    filePath: string,
    id: string,
    worktreeId?: string,
    relativePath?: string,
    options?: EditorPanelContentLoadOptions
  ) => Promise<void>
  openFilesRef: MutableRefObject<OpenFile[]>
  editorViewModeRef: MutableRefObject<EditorViewModeByFile>
  setFileContents: Dispatch<SetStateAction<Record<string, FileContent>>>
  setDiffContents: Dispatch<SetStateAction<Record<string, DiffContent>>>
}

const externalEventGenerations = new WeakMap<Event, number>()
let externalEventGenerationCounter = 0

function getExternalEventGeneration(event: Event): number {
  const existing = externalEventGenerations.get(event)
  if (existing !== undefined) {
    return existing
  }
  const generation = ++externalEventGenerationCounter
  externalEventGenerations.set(event, generation)
  return generation
}

export function useEditorPanelExternalContentEvents({
  activeContentFileIdRef,
  invalidateContent,
  invalidateDiffContent,
  isVisibleRef,
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
      const eventGeneration = getExternalEventGeneration(event)
      const invalidatedDiffFileIds: string[] = []
      const invalidatedFileIds: string[] = []
      for (const file of getOpenFilesForExternalFileChange(openFilesRef.current, detail)) {
        // Why: a dirty file keeps its unsaved buffer (issue #7265) — it is
        // marked changed-on-disk upstream and resolves via the editor banner,
        // a save, or a later clean reload. Reloading here would clobber it.
        if (file.isDirty) {
          continue
        }
        if (!isVisibleRef.current || file.id !== activeContentFileIdRef.current) {
          invalidatedFileIds.push(file.id)
          continue
        }
        if (file.mode === 'edit' || file.mode === 'markdown-preview') {
          // Why: external writes must replace any in-flight pre-change read so
          // the tab shows the new on-disk content, not a stale dedupe result.
          void loadFileContent(file.filePath, file.id, file.worktreeId, file.relativePath, {
            force: true,
            externalEventGeneration: eventGeneration
          })
          if (editorViewModeRef.current[file.id] === 'changes') {
            void loadDiffContent(file, {
              force: true,
              externalEventGeneration: eventGeneration
            })
          } else {
            invalidatedDiffFileIds.push(file.id)
          }
        } else if (isReloadableSingleFileDiffTab(file)) {
          void loadDiffContent(file, {
            force: true,
            externalEventGeneration: eventGeneration
          })
        }
      }
      if (invalidatedFileIds.length > 0) {
        invalidateContent(invalidatedFileIds)
      }
      if (invalidatedDiffFileIds.length > 0) {
        invalidateDiffContent(invalidatedDiffFileIds)
      }
    }
    window.addEventListener(ORCA_EDITOR_EXTERNAL_FILE_CHANGE_EVENT, handler as EventListener)
    return () =>
      window.removeEventListener(ORCA_EDITOR_EXTERNAL_FILE_CHANGE_EVENT, handler as EventListener)
  }, [
    activeContentFileIdRef,
    editorViewModeRef,
    invalidateContent,
    invalidateDiffContent,
    isVisibleRef,
    loadDiffContent,
    loadFileContent,
    openFilesRef
  ])

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
  fileReadGenerationRef: MutableRefObject<Record<string, number>>,
  diffReadGenerationRef: MutableRefObject<Record<string, number>>,
  setFileContents: Dispatch<SetStateAction<Record<string, FileContent>>>,
  setDiffContents: Dispatch<SetStateAction<Record<string, DiffContent>>>
): void {
  const knownOpenFileIdsRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    const openIds = new Set(openFiles.map((f) => f.id))
    for (const fileId of openIds) {
      knownOpenFileIdsRef.current.add(fileId)
    }
    for (const fileId of Object.keys(fileLoadRetryAttemptsRef.current)) {
      if (!openIds.has(fileId)) {
        delete fileLoadRetryAttemptsRef.current[fileId]
      }
    }
    // Why: conflict-review entry loads use absolute paths as content ids; only
    // ids that have belonged to tabs are safe to prune as closed tabs.
    for (const fileId of Object.keys(fileReadGenerationRef.current)) {
      if (knownOpenFileIdsRef.current.has(fileId) && !openIds.has(fileId)) {
        delete fileReadGenerationRef.current[fileId]
      }
    }
    for (const fileId of Object.keys(diffReadGenerationRef.current)) {
      if (knownOpenFileIdsRef.current.has(fileId) && !openIds.has(fileId)) {
        delete diffReadGenerationRef.current[fileId]
      }
    }
    setFileContents((prev) =>
      Object.fromEntries(Object.entries(prev).filter(([key]) => openIds.has(key)))
    )
    setDiffContents((prev) =>
      Object.fromEntries(Object.entries(prev).filter(([key]) => openIds.has(key)))
    )
  }, [
    diffReadGenerationRef,
    fileLoadRetryAttemptsRef,
    fileReadGenerationRef,
    knownOpenFileIdsRef,
    openFiles,
    setDiffContents,
    setFileContents
  ])
}
