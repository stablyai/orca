import { useCallback, useLayoutEffect, useRef, type MutableRefObject } from 'react'
import type { editor } from 'monaco-editor'
import { syncContentUpdate, type MonacoContentSyncMode } from './monaco-content-sync'
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

/** Why the caller owns `contentRef`/`contentSyncModeRef`: both are latest-value refs
 *  assigned during render, which must happen in the component body so the mount
 *  handler and any handler firing before commit already read the current props. */
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
        if (editorRef.current?.getModel()?.uri.toString() !== modelKey) {
          return
        }
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
