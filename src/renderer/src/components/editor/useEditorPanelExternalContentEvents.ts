import { useEffect, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import { useAppStore } from '@/store'
import { getConnectionIdForFile } from '@/lib/connection-context'
import type { OpenFile } from '@/store/slices/editor'
import {
  getOpenFilesForExternalFileChange,
  ORCA_EDITOR_EXTERNAL_FILE_CHANGE_EVENT,
  ORCA_EDITOR_FILE_CACHE_STALE_EVENT,
  ORCA_EDITOR_FILE_SAVED_EVENT,
  type EditorFileSavedDetail,
  type EditorPathMutationTarget
} from './editor-autosave'
import type { DiffContent, FileContent } from './editor-panel-content-types'
import { isReloadableSingleFileDiffTab } from './editor-panel-diff-reload'
import { createEditorWatcherReloadCoalescer } from './editor-watcher-reload-coalescer'
import { markFileChangedOnDisk } from './editor-changed-on-disk-mark'
import { hasRecentSelfWrite } from './editor-self-write-registry'
import { editorModelSiblingTabs, isEditorModelDirty } from './editor-save-disk-precondition'
import { withRecordDiskText } from './editor-buffer-adapter'

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
    const reloads = createEditorWatcherReloadCoalescer()
    // Why: a coalesced follow-up starts later; re-check the tab. A closed tab is skipped; one that
    // left the screen is marked stale so its queued change reloads on reveal; one edited meanwhile
    // keeps its draft but records that disk moved, so autosave can't silently overwrite it.
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
        await loadDiffContent(target, { force: true, externalEventGeneration: eventGeneration })
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
      const matched = getOpenFilesForExternalFileChange(openFilesRef.current, detail)
      // Why: a tab of another workspace showing the same model is stale too.
      const siblingIds = new Set(
        matched.flatMap((file) =>
          storeState?.openFiles?.some((tab) => tab.id === file.id)
            ? editorModelSiblingTabs(storeState, file).map((tab) => tab.id)
            : [file.id]
        )
      )
      for (const file of openFilesRef.current.filter((tab) => siblingIds.has(tab.id))) {
        // Why: a dirty file keeps its unsaved buffer (issue #7265) — it is
        // marked changed-on-disk upstream and resolves via the editor banner,
        // a save, or a later clean reload. Reloading here would clobber it. A
        // clean tab of a model another tab is editing shows that buffer too.
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
          // Why: external writes must replace any in-flight pre-change read so
          // the tab shows the new on-disk content, not a stale dedupe result.
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

  useEffect(() => {
    const handler = (event: Event): void => {
      const detail = (event as CustomEvent<EditorFileSavedDetail>).detail
      if (!detail) {
        return
      }
      const file = openFilesRef.current.find((openFile) => openFile.id === detail.fileId)
      const recordViewIds = detail.recordViewIds ?? [detail.fileId]
      updateSavedPreviewTabs(openFilesRef.current, detail, setFileContents)
      if (!file) {
        // Why: the saving tab closed mid-save; the record's other views still move to the disk text.
        setFileContents((prev) =>
          withRecordDiskText(prev, recordViewIds, detail.fileId, detail.content)
        )
        return
      }
      if (file.mode === 'edit' || file.mode === 'markdown-preview') {
        setFileContents((prev) => ({
          ...withRecordDiskText(prev, recordViewIds, file.id, detail.content),
          [file.id]: { content: detail.content, isBinary: false }
        }))
      }
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
    // Why evict, not mark stale: stale bytes kept for display could be mounted into the live model.
    const onCacheStale = (event: Event): void => {
      if (event instanceof CustomEvent && typeof event.detail?.fileId === 'string') {
        const fileId: string = event.detail.fileId
        setFileContents((prev) => {
          if (!(fileId in prev)) {
            return prev
          }
          const next = { ...prev }
          delete next[fileId]
          return next
        })
        // Why: the visible tab has no other trigger to reload; hidden tabs load lazily on reveal.
        const file = openFilesRef.current.find((candidate) => candidate.id === fileId)
        if (file && isVisibleRef.current && fileId === activeContentFileIdRef.current) {
          void loadFileContent(file.filePath, file.id, file.worktreeId, file.relativePath, {
            force: true
          })
        }
      }
    }
    window.addEventListener(ORCA_EDITOR_FILE_SAVED_EVENT, handler)
    window.addEventListener(ORCA_EDITOR_FILE_CACHE_STALE_EVENT, onCacheStale)
    return () => {
      window.removeEventListener(ORCA_EDITOR_FILE_SAVED_EVENT, handler)
      window.removeEventListener(ORCA_EDITOR_FILE_CACHE_STALE_EVENT, onCacheStale)
    }
  }, [
    activeContentFileIdRef,
    isVisibleRef,
    loadFileContent,
    openFilesRef,
    setDiffContents,
    setFileContents
  ])
}

function updateSavedPreviewTabs(
  openFiles: OpenFile[],
  detail: EditorFileSavedDetail,
  setFileContents: Dispatch<SetStateAction<Record<string, FileContent>>>
): void {
  // Why the record's views: the saving view may have closed while its siblings' previews remain.
  const sources = new Set<string | undefined>([detail.fileId, ...(detail.recordViewIds ?? [])])
  const previewTabs = openFiles.filter(
    (openFile) =>
      openFile.mode === 'markdown-preview' && sources.has(openFile.markdownPreviewSourceFileId)
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
