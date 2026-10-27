import { useCallback, useLayoutEffect, useRef, type MutableRefObject } from 'react'
import type { editor } from 'monaco-editor'
import { syncContentUpdate, type MonacoContentSyncMode } from './monaco-content-sync'
import { mayPushTabTextIntoModel } from './editor-stale-mount-guard'
import {
  beginProgrammaticContentSync,
  endProgrammaticContentSync,
  shouldIgnoreMonacoContentChange
} from './monaco-programmatic-sync'

export type MonacoContentSyncBridge = {
  contentRef: MutableRefObject<string>
  lastSyncedContentRef: MutableRefObject<string>
  contentSyncModeRef: MutableRefObject<MonacoContentSyncMode>
  isApplyingProgrammaticContentRef: MutableRefObject<boolean>
  isApplyingLargePasteRef: MutableRefObject<boolean>
  handleChange: (value: string | undefined) => void
}

/** Callers update the content/mode refs during render so mount handlers can read current props before commit. */
export function useMonacoContentSyncBridge(params: {
  editorRef: MutableRefObject<editor.IStandaloneCodeEditor | null>
  content: string
  contentRef: MutableRefObject<string>
  contentSyncModeRef: MutableRefObject<MonacoContentSyncMode>
  modelKey: string
  /** The tab whose text this editor shows; disk text from it never enters a dirty model. */
  fileId?: string
  onContentChange: (content: string) => void
}): MonacoContentSyncBridge {
  const { editorRef, content, contentRef, contentSyncModeRef, modelKey, onContentChange, fileId } =
    params

  const lastSyncedContentRef = useRef<string>(content)

  // Suppress reconciliation’s real edit events so programmatic updates do not mark the file dirty.
  const isApplyingProgrammaticContentRef = useRef(false)
  const isApplyingLargePasteRef = useRef(false)

  const handleChange = useCallback(
    (value: string | undefined) => {
      if (value !== undefined) {
        if (editorRef.current?.getModel()?.uri.toString() !== modelKey) {
          return
        }
        // Publish chunked pastes only on completion instead of scheduling saves for intermediate content.
        if (isApplyingLargePasteRef.current) {
          lastSyncedContentRef.current = value
          return
        }
        if (
          shouldIgnoreMonacoContentChange({
            modelKey,
            isApplyingProgrammaticContent: isApplyingProgrammaticContentRef.current
          })
        ) {
          return
        }
        lastSyncedContentRef.current = value
        onContentChange(value)
      }
    },
    [editorRef, modelKey, onContentChange]
  )

  // Reconcile external prop changes before paint to avoid stale-text flashes; mount handles retained models separately.
  useLayoutEffect(() => {
    const ed = editorRef.current
    if (
      !ed ||
      ed.getModel()?.uri.toString() !== modelKey ||
      lastSyncedContentRef.current === content ||
      (fileId !== undefined && !mayPushTabTextIntoModel(fileId))
    ) {
      return
    }
    beginProgrammaticContentSync(modelKey)
    isApplyingProgrammaticContentRef.current = true
    try {
      syncContentUpdate(ed, content, contentSyncModeRef.current)
      lastSyncedContentRef.current = content
    } finally {
      isApplyingProgrammaticContentRef.current = false
      endProgrammaticContentSync(modelKey)
    }
  }, [content, contentSyncModeRef, editorRef, fileId, modelKey])

  return {
    contentRef,
    lastSyncedContentRef,
    contentSyncModeRef,
    isApplyingProgrammaticContentRef,
    isApplyingLargePasteRef,
    handleChange
  }
}
