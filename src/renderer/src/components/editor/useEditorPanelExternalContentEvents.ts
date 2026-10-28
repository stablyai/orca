import { useEffect, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import { useAppStore } from '@/store'
import { getConnectionIdForFile } from '@/lib/connection-context'
import type { OpenFile } from '@/store/slices/editor'
import {
  ORCA_EDITOR_EXTERNAL_FILE_CHANGE_EVENT,
  type EditorPathMutationTarget
} from './editor-autosave'
import type { DiffContent, FileContent } from './editor-panel-content-types'
import { isReloadableSingleFileDiffTab } from './editor-panel-diff-reload'
import { createEditorWatcherReloadCoalescer } from './editor-watcher-reload-coalescer'
import { markFileChangedOnDisk } from './editor-changed-on-disk-mark'
import { hasRecentSelfWrite } from './editor-self-write-registry'
import { isEditorModelDirty } from './editor-save-disk-precondition'
import { externalChangeRecordViewIds } from './editor-buffer-adapter'
import { useEditorPanelDiskTextEvents } from './useEditorPanelDiskTextEvents'

type EditorViewModeByFile = ReturnType<typeof useAppStore.getState>['editorViewMode']

export type EditorPanelContentLoadOptions = {
  force?: boolean
  externalEventGeneration?: number
  /** The active tab's load or its Retry: a user act that may start a stopped WSL distro. */
  wakeWslDistro?: boolean
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
  supersedeFileReads: (fileIds: readonly string[]) => void
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
  setDiffContents,
  supersedeFileReads
}: UseEditorPanelExternalContentEventsParams): void {
  useEffect(() => {
    const reloads = createEditorWatcherReloadCoalescer()
    // Recheck queued targets: skip closed tabs, invalidate hidden ones and mark newly dirty drafts as conflicting instead of reloading.
    const resolveReloadTarget = (fileId: string): OpenFile | 'stale' | null => {
      const file = openFilesRef.current.find((candidate) => candidate.id === fileId)
      if (!file) {
        return null
      }
      const state = useAppStore.getState()
      if (file.isDirty) {
        if (!hasRecentSelfWrite(file.filePath, file.runtimeEnvironmentId)) {
          markFileChangedOnDisk(useAppStore.getState(), file, {
            connectionId: getConnectionIdForFile(file.worktreeId, file.filePath) ?? undefined,
            origin: 'live'
          })
        }
        return 'stale'
      }
      // Why: a clean tab of a model another tab is editing shows that buffer; never reload it alone.
      if (isEditorModelDirty(state, file)) {
        return null
      }
      return isVisibleRef.current && file.id === activeContentFileIdRef.current ? file : 'stale'
    }
    const runContentReload = async (fileId: string, eventGeneration: number): Promise<void> => {
      const target = resolveReloadTarget(fileId)
      if (target === 'stale') {
        invalidateContent([fileId])
      } else if (target) {
        await loadFileContent(target.filePath, target.id, target.worktreeId, target.relativePath, {
          force: true,
          externalEventGeneration: eventGeneration
        })
      }
    }
    const runDiffReload = async (fileId: string, eventGeneration: number): Promise<void> => {
      const target = resolveReloadTarget(fileId)
      if (target === 'stale') {
        invalidateDiffContent([fileId])
      } else if (target) {
        await loadDiffContent(target, {
          force: true,
          externalEventGeneration: eventGeneration
        })
      }
    }
    const handler = (event: Event): void => {
      const detail = (event as CustomEvent<EditorPathMutationTarget>).detail
      if (!detail) {
        return
      }
      const eventGeneration = getExternalEventGeneration(event)
      const invalidatedDiffFileIds: string[] = []
      const invalidatedFileIds: string[] = []
      const storeState = useAppStore.getState()
      const siblingIds = externalChangeRecordViewIds(storeState, openFilesRef.current, detail)
      for (const file of openFilesRef.current.filter((tab) => siblingIds.has(tab.id))) {
        // Preserve unsaved shared buffers, including clean sibling views; the conflict banner owns their resolution.
        if (
          file.isDirty ||
          (storeState.openFiles.some((tab) => tab.id === file.id) &&
            isEditorModelDirty(storeState, file))
        ) {
          continue
        }
        if (!isVisibleRef.current || file.id !== activeContentFileIdRef.current) {
          invalidatedFileIds.push(file.id)
          continue
        }
        if (file.mode === 'edit' || file.mode === 'markdown-preview') {
          // External changes must supersede reads started before the write instead of reusing stale dedupe results.
          reloads.run(`content:${file.id}`, () => runContentReload(file.id, eventGeneration))
          if (editorViewModeRef.current[file.id] === 'changes') {
            reloads.run(`diff:${file.id}`, () => runDiffReload(file.id, eventGeneration))
          } else {
            invalidatedDiffFileIds.push(file.id)
          }
        } else if (isReloadableSingleFileDiffTab(file)) {
          reloads.run(`diff:${file.id}`, () => runDiffReload(file.id, eventGeneration))
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
    return () => {
      reloads.dispose()
      window.removeEventListener(ORCA_EDITOR_EXTERNAL_FILE_CHANGE_EVENT, handler as EventListener)
    }
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

  useEditorPanelDiskTextEvents({
    activeContentFileIdRef,
    invalidateDiffContent,
    isVisibleRef,
    loadFileContent,
    openFilesRef,
    setFileContents,
    setDiffContents,
    supersedeFileReads
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
    // Conflict-review paths can be content IDs without tabs; prune only IDs known to have belonged to closed tabs.
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
