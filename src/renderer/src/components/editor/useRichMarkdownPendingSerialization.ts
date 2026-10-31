import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type FocusEvent,
  type MutableRefObject
} from 'react'
import type { Editor } from '@tiptap/react'
import { registerPendingEditorFlush } from './editor-pending-flush'
import { focusLeftView, staleViewEditEpoch } from './editor-stale-view-edit'
import { commitRichMarkdownSerialization } from './rich-markdown-serialization-commit'

type PendingSerializationParams = {
  fileId: string
  editorRef: MutableRefObject<Editor | null>
  lastCommittedMarkdownRef: MutableRefObject<string>
  originalSourceRef: MutableRefObject<string>
  baseCanonicalRef: MutableRefObject<string>
  onContentChangeRef: MutableRefObject<(content: string) => void>
  reconcileRoundTripRef: MutableRefObject<(markdown: string) => string | null>
}

/** Owns the rich view's debounced serialization: commit, stale-edit rejection, and flush triggers. */
export function useRichMarkdownPendingSerialization({
  fileId,
  editorRef,
  lastCommittedMarkdownRef,
  originalSourceRef,
  baseCanonicalRef,
  onContentChangeRef,
  reconcileRoundTripRef
}: PendingSerializationParams) {
  const serializeTimerRef = useRef<number | null>(null)
  // Why: the discard epoch when the pending edit began; a Discard since then drops it silently.
  const pendingEditEpochRef = useRef(0)
  const flushPendingSerialization = useCallback((): boolean => {
    if (serializeTimerRef.current === null) {
      return false
    }
    window.clearTimeout(serializeTimerRef.current)
    serializeTimerRef.current = null
    if (pendingEditEpochRef.current !== staleViewEditEpoch(fileId)) {
      // Why: a Discard since typing began owns the text and dirty flag now.
      return true
    }
    try {
      const { markdown, didSerialize } = commitRichMarkdownSerialization(
        editorRef.current,
        { originalSourceRef, baseCanonicalRef, lastCommittedMarkdownRef },
        reconcileRoundTripRef.current
      )
      if (didSerialize) {
        onContentChangeRef.current(markdown)
      }
    } catch (error) {
      // Why: teardown and reconcile failures are handled above; other failures must stay observable.
      console.error('[editor] rich markdown serialize (flush) failed', error)
    }
    return false
  }, [
    fileId,
    editorRef,
    lastCommittedMarkdownRef,
    originalSourceRef,
    baseCanonicalRef,
    onContentChangeRef,
    reconcileRoundTripRef
  ])

  useEffect(() => {
    // Expose synchronous flushing to autosave/restart so pending typing cannot leave a dirty-without-draft debounce window.
    return registerPendingEditorFlush(fileId, flushPendingSerialization)
  }, [fileId, flushPendingSerialization])

  // Flush in layout cleanup before Tiptap’s passive cleanup destroys the editor on tab/mode changes.
  useLayoutEffect(() => {
    return () => {
      flushPendingSerialization()
    }
  }, [flushPendingSerialization])

  const flushOnFocusLeave = useCallback(
    (event: FocusEvent<HTMLDivElement>) => {
      if (focusLeftView(event)) {
        flushPendingSerialization()
      }
    },
    [flushPendingSerialization]
  )

  return {
    serializeTimerRef,
    pendingEditEpochRef,
    flushPendingSerialization,
    flushOnFocusLeave
  }
}
