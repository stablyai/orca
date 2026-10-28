import { useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import type { OpenFile } from '@/store/slices/editor'
import {
  ORCA_EDITOR_FILE_CACHE_STALE_EVENT,
  ORCA_EDITOR_FILE_RELOADED_EVENT,
  ORCA_EDITOR_FILE_SAVED_EVENT,
  type EditorFileCacheStaleDetail,
  type EditorFileSavedDetail
} from './editor-autosave'
import type { DiffContent, FileContent } from './editor-panel-content-types'
import { withRecordDiskText } from './editor-buffer-adapter'
import type { EditorPanelFileContentLoader } from './useEditorPanelFileContentLoader'

/** Saved and reloaded disk text, and dropped caches, for every view this panel holds. */
export function useEditorPanelDiskTextEvents({
  activeContentFileIdRef,
  invalidateDiffContent,
  isVisibleRef,
  loadFileContent,
  openFilesRef,
  setFileContents,
  setDiffContents,
  supersedeFileReads
}: {
  activeContentFileIdRef: MutableRefObject<string | null>
  invalidateDiffContent: (fileIds: string[]) => void
  isVisibleRef: MutableRefObject<boolean>
  loadFileContent: EditorPanelFileContentLoader
  openFilesRef: MutableRefObject<OpenFile[]>
  setFileContents: Dispatch<SetStateAction<Record<string, FileContent>>>
  setDiffContents: Dispatch<SetStateAction<Record<string, DiffContent>>>
  supersedeFileReads: (fileIds: readonly string[]) => void
}): void {
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
        // Saved text still reaches record siblings after the saving view closes.
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
        return {
          ...prev,
          [file.id]: { ...existing, modifiedContent: detail.content }
        }
      })
    }
    // Why supersede: a read that started before the reload must not land over its accepted bytes.
    const onReloaded = (event: Event): void => {
      const detail = (event as CustomEvent<EditorFileSavedDetail>).detail
      if (!detail) {
        return
      }
      const sources = new Set([detail.fileId, ...(detail.recordViewIds ?? [])])
      const previewIds = openFilesRef.current
        .filter(
          (file) =>
            file.mode === 'markdown-preview' && sources.has(file.markdownPreviewSourceFileId ?? '')
        )
        .map((file) => file.id)
      const viewIds = [...sources, ...previewIds]
      supersedeFileReads(viewIds)
      // Every view takes the accepted text, replacing any error or binary state it showed.
      setFileContents((prev) => {
        const next = { ...prev }
        for (const viewId of viewIds) {
          next[viewId] = { content: detail.content, isBinary: false }
        }
        return next
      })
      invalidateDiffContent([...sources])
    }
    // Why evict, not mark stale: stale bytes kept for display could be mounted into the live model.
    const onCacheStale = (event: Event): void => {
      if (event instanceof CustomEvent && typeof event.detail?.fileId === 'string') {
        const detail: EditorFileCacheStaleDetail = event.detail
        const fileId = detail.fileId
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
            force: true,
            ...(detail.userReload ? { wakeWslDistro: true } : {})
          })
        }
        if (detail.userReload) {
          invalidateDiffContent([fileId])
        }
      }
    }
    window.addEventListener(ORCA_EDITOR_FILE_SAVED_EVENT, handler)
    window.addEventListener(ORCA_EDITOR_FILE_RELOADED_EVENT, onReloaded)
    window.addEventListener(ORCA_EDITOR_FILE_CACHE_STALE_EVENT, onCacheStale)
    return () => {
      window.removeEventListener(ORCA_EDITOR_FILE_SAVED_EVENT, handler)
      window.removeEventListener(ORCA_EDITOR_FILE_RELOADED_EVENT, onReloaded)
      window.removeEventListener(ORCA_EDITOR_FILE_CACHE_STALE_EVENT, onCacheStale)
    }
  }, [
    activeContentFileIdRef,
    invalidateDiffContent,
    isVisibleRef,
    loadFileContent,
    openFilesRef,
    setDiffContents,
    setFileContents,
    supersedeFileReads
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
