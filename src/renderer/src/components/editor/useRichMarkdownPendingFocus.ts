import { useEffect, type RefObject } from 'react'
import type { Editor } from '@tiptap/react'
import { useAppStore } from '@/store'
import { autoFocusRichEditor } from './rich-markdown-auto-focus'
import { matchesPendingEditorFocusRequest } from './pending-editor-focus-request'

type PendingFocusOptions = {
  editor: Editor | null
  fileId: string
  viewStateId: string
  worktreeId: string
  rootRef: RefObject<HTMLDivElement | null>
  cancelAutoFocusRef: RefObject<(() => void) | null>
}

/**
 * Focuses the editor when the Explorer opens this document for find (issue #8083). The request is
 * scoped to one pane (`viewStateId`) so split siblings can't claim it, and stays armed until focus
 * actually lands — Tiptap can replace the instance first — or until its TTL retires it, so a later
 * unrelated remount of the same file never steals focus.
 */
export function useRichMarkdownPendingFocus({
  editor,
  fileId,
  viewStateId,
  worktreeId,
  rootRef,
  cancelAutoFocusRef
}: PendingFocusOptions): void {
  const pendingEditorFocusRequest = useAppStore((s) => {
    const request = s.pendingEditorFocusRequest
    return matchesPendingEditorFocusRequest(request, { fileId, worktreeId, viewStateId })
      ? request
      : null
  })
  const consumeEditorFocusRequest = useAppStore((s) => s.consumeEditorFocusRequest)

  useEffect(() => {
    if (!pendingEditorFocusRequest) {
      return
    }
    if (pendingEditorFocusRequest.expiresAt <= Date.now()) {
      consumeEditorFocusRequest(pendingEditorFocusRequest.token)
      return
    }
    if (!editor || editor.isDestroyed) {
      return
    }
    let consumed = false
    const consumeIfFocused = (): void => {
      if (
        consumed ||
        (rootRef.current?.contains(document.activeElement) !== true && !editor.isFocused)
      ) {
        return
      }
      consumed = true
      consumeEditorFocusRequest(pendingEditorFocusRequest.token)
    }
    editor.on('focus', consumeIfFocused)
    cancelAutoFocusRef.current?.()
    cancelAutoFocusRef.current = autoFocusRichEditor(
      editor,
      rootRef.current,
      true,
      () => pendingEditorFocusRequest.expiresAt > Date.now()
    )
    const expiryTimer = window.setTimeout(() => {
      cancelAutoFocusRef.current?.()
      cancelAutoFocusRef.current = null
      consumeEditorFocusRequest(pendingEditorFocusRequest.token)
    }, pendingEditorFocusRequest.expiresAt - Date.now())
    consumeIfFocused()
    return () => {
      window.clearTimeout(expiryTimer)
      editor.off('focus', consumeIfFocused)
    }
  }, [cancelAutoFocusRef, consumeEditorFocusRequest, editor, pendingEditorFocusRequest, rootRef])
}
