import { useEffect, type RefObject } from 'react'
import type { Editor } from '@tiptap/react'
import { useAppStore } from '@/store'
import { autoFocusRichEditor } from './rich-markdown-auto-focus'

type PendingFocusOptions = {
  editor: Editor | null
  fileId: string
  worktreeId: string
  rootRef: RefObject<HTMLDivElement | null>
  cancelAutoFocusRef: RefObject<(() => void) | null>
}

/**
 * Focuses the editor when the Explorer opens this document for find (issue #8083), then consumes
 * the request so a later remount of the same file does not steal focus again.
 */
export function useRichMarkdownPendingFocus({
  editor,
  fileId,
  worktreeId,
  rootRef,
  cancelAutoFocusRef
}: PendingFocusOptions): void {
  const pendingEditorFocusRequest = useAppStore((s) => {
    const request = s.pendingEditorFocusRequest
    return request?.fileId === fileId && request.worktreeId === worktreeId ? request : null
  })
  const consumeEditorFocusRequest = useAppStore((s) => s.consumeEditorFocusRequest)

  useEffect(() => {
    if (!editor || !pendingEditorFocusRequest) {
      return
    }
    cancelAutoFocusRef.current?.()
    cancelAutoFocusRef.current = autoFocusRichEditor(editor, rootRef.current, true)
    consumeEditorFocusRequest(pendingEditorFocusRequest.token)
  }, [cancelAutoFocusRef, consumeEditorFocusRequest, editor, pendingEditorFocusRequest, rootRef])
}
