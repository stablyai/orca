import { useCallback, useLayoutEffect, useRef, type MutableRefObject } from 'react'
import type { editor } from 'monaco-editor'
import { syncContentUpdate, type MonacoContentSyncMode } from './monaco-content-sync'
import {
  beginProgrammaticContentSync,
  endProgrammaticContentSync,
  shouldIgnoreMonacoContentChange
} from './monaco-programmatic-sync'
import {
  flushEditorModelContentCheckpoint,
  isCurrentEditorModelContent,
  isStaleEditorModelContent
} from './editor-model-content-checkpoint'

export type MonacoContentSyncBridge = {
  contentRef: MutableRefObject<string>
  lastSyncedContentRef: MutableRefObject<string>
  contentSyncModeRef: MutableRefObject<MonacoContentSyncMode>
  isApplyingProgrammaticContentRef: MutableRefObject<boolean>
  isApplyingLargePasteRef: MutableRefObject<boolean>
  handleChange: (value: string | undefined) => void
}

/** Mount and reconciliation read the latest committed content and sync mode. */
export function useMonacoContentSyncBridge(params: {
  editorRef: MutableRefObject<editor.IStandaloneCodeEditor | null>
  content: string
  contentRef: MutableRefObject<string>
  contentSyncModeRef: MutableRefObject<MonacoContentSyncMode>
  modelKey: string
  onContentChange: (content: string) => void
}): MonacoContentSyncBridge {
  const { editorRef, content, contentRef, contentSyncModeRef, modelKey, onContentChange } = params

  const lastSyncedContentRef = useRef<string>(content)

  // Why: reconciliation uses real edit ops (to keep undo sane), so these programmatic edits must suppress onChange or they'd mark the file dirty.
  const isApplyingProgrammaticContentRef = useRef(false)
  const isApplyingLargePasteRef = useRef(false)

  const handleChange = useCallback(
    (value: string | undefined) => {
      if (value !== undefined) {
        // Why: split panes share one retained model, so a sibling must ignore the echoed programmatic-sync onChange or it marks the file dirty.
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

  // Why: sync the model on external `content` drift; useLayoutEffect lands the overwrite before paint so no stale text flashes. On-mount handled in handleMount.
  useLayoutEffect(() => {
    const ed = editorRef.current
    if (
      !ed ||
      ed.getModel()?.uri.toString() !== modelKey ||
      lastSyncedContentRef.current === content
    ) {
      return
    }
    const model = ed.getModel()
    if (model) {
      if (
        isStaleEditorModelContent(model, content) ||
        isCurrentEditorModelContent(model, content)
      ) {
        lastSyncedContentRef.current = content
        return
      }
      flushEditorModelContentCheckpoint(model)
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
  }, [content, contentSyncModeRef, editorRef, modelKey])

  return {
    contentRef,
    lastSyncedContentRef,
    contentSyncModeRef,
    isApplyingProgrammaticContentRef,
    isApplyingLargePasteRef,
    handleChange
  }
}
