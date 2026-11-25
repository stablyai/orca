import { useLayoutEffect, useRef, type MutableRefObject } from 'react'
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
}

/** Callers update the content/mode refs during render so mount handlers can read current props before commit. */
export function useMonacoContentSyncBridge(params: {
  editorRef: MutableRefObject<editor.IStandaloneCodeEditor | null>
  mountedEditor: editor.IStandaloneCodeEditor | null
  content: string
  contentRef: MutableRefObject<string>
  contentSyncModeRef: MutableRefObject<MonacoContentSyncMode>
  modelKey: string
  /** The tab whose text this editor shows; disk text from it never enters a dirty model. */
  fileId?: string
  onContentChange: (content: string) => void
}): MonacoContentSyncBridge {
  const {
    editorRef,
    mountedEditor,
    content,
    contentRef,
    contentSyncModeRef,
    modelKey,
    onContentChange,
    fileId
  } = params

  const lastSyncedContentRef = useRef<string>(content)

  // Suppress reconciliation’s real edit events so programmatic updates do not mark the file dirty.
  const isApplyingProgrammaticContentRef = useRef(false)

  useLayoutEffect(() => {
    if (!mountedEditor) {
      return
    }
    const subscription = mountedEditor.onDidChangeModelContent(() => {
      if (
        editorRef.current !== mountedEditor ||
        mountedEditor.getModel()?.uri.toString() !== modelKey
      ) {
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
      const value = mountedEditor.getValue()
      lastSyncedContentRef.current = value
      onContentChange(value)
    })
    return () => subscription.dispose()
  }, [editorRef, modelKey, mountedEditor, onContentChange])

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
    isApplyingProgrammaticContentRef
  }
}
