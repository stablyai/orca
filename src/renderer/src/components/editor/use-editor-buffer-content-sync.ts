import { useEffect, useRef, type Dispatch, type SetStateAction } from 'react'
import { useAppStore } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import {
  editorBufferViewIds,
  liveEditorBufferViewOf
} from '@/store/slices/editor/buffers/editor-buffer-record'
import type { FileContent } from './editor-panel-content-types'

type BufferContentListener = (sourceFileId: string, content: FileContent) => void

const listeners = new Set<BufferContentListener>()

/**
 * Delivers a disk read or save to every mounted panel showing the file's record, whether or not
 * the panel that started it is still mounted.
 */
export function publishEditorBufferContent(sourceFileId: string, content: FileContent): void {
  for (const listener of listeners) {
    listener(sourceFileId, content)
  }
}

/** Publishes a read of a record through any tab still showing it; returns that tab's id. */
export function publishEditorBufferRead(
  recordId: string,
  startedByFileId: string,
  content: FileContent
): string {
  const viewId = liveEditorBufferViewOf(useAppStore.getState(), recordId) ?? startedByFileId
  publishEditorBufferContent(viewId, content)
  return viewId
}

function isFreshText(content: FileContent | undefined): content is FileContent {
  return content !== undefined && !content.loadError && content.isStale !== true
}

/**
 * Why: tabs of one buffer record share one Monaco model, and a mounting editor reconciles that
 * model to its panel's cached disk text. Each panel caches per tab, so when one panel learns new
 * disk text (load, reload, save) every panel's cache for the same record must follow, or a stale
 * cache would push old text back into the shared model.
 */
export function useEditorBufferContentSync(
  fileContents: Record<string, FileContent>,
  setFileContents: Dispatch<SetStateAction<Record<string, FileContent>>>,
  openFilesRef: { current: OpenFile[] },
  /** Whether this panel has read (or is reading) a tab, so newer text may fill it. */
  tracksRead?: (fileId: string) => boolean
): void {
  const previousRef = useRef(fileContents)
  // Entries this panel received from another panel; re-publishing them would echo.
  const receivedRef = useRef(new WeakSet<FileContent>())

  useEffect(() => {
    const listener: BufferContentListener = (sourceFileId, content) => {
      const state = useAppStore.getState()
      // Why not live tails: each tail appends from its own offset, so shared bytes would repeat.
      const ids = editorBufferViewIds(state, sourceFileId).filter(
        (id) => state.openFiles.find((file) => file.id === id)?.liveTail !== true
      )
      receivedRef.current.add(content)
      // Why seed: this panel's own read of the tab was superseded by this newer text, so without
      // it the tab would stay loading. Publishing never cancels reads; freshness is per record.
      const reading = new Set(ids.filter((id) => tracksRead?.(id) === true))
      setFileContents((prev) => {
        let next = prev
        for (const id of ids) {
          const existing = prev[id]
          if (
            (!existing && !reading.has(id)) ||
            existing === content ||
            (existing && isSameText(existing, content))
          ) {
            continue
          }
          next = next === prev ? { ...prev } : next
          next[id] = content
        }
        return next
      })
    }
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }, [setFileContents, tracksRead])

  useEffect(() => {
    const previous = previousRef.current
    previousRef.current = fileContents
    if (previous === fileContents) {
      return
    }
    for (const [fileId, content] of Object.entries(fileContents)) {
      if (
        content === previous[fileId] ||
        !isFreshText(content) ||
        receivedRef.current.has(content) ||
        !isSharedTextView(openFilesRef.current.find((file) => file.id === fileId))
      ) {
        continue
      }
      publishEditorBufferContent(fileId, content)
    }
  }, [fileContents, openFilesRef])
}

function isSharedTextView(file: OpenFile | undefined): boolean {
  return file?.mode === 'edit' && file.liveTail !== true
}

function isSameText(a: FileContent, b: FileContent): boolean {
  return a.isStale !== true && !a.loadError && a.content === b.content && a.isBinary === b.isBinary
}
