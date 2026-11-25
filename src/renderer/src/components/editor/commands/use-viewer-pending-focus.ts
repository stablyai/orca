import { useEffect, type RefObject } from 'react'
import { useAppStore } from '@/store/index'
import { matchesPendingEditorFocusRequest } from './pending-editor-focus-request'

export type ViewerFocusPane = { file: { id: string; worktreeId: string }; viewStateId: string }

/**
 * Claims an open's focus handoff for a viewer that has no text editor (PDF), so keys like
 * PageUp/PageDown reach the document instead of the panel that opened it.
 */
export function useViewerPendingFocus(
  pane: ViewerFocusPane | null,
  targetRef: RefObject<HTMLElement | null>
): void {
  const request = useAppStore((s) =>
    pane &&
    matchesPendingEditorFocusRequest(s.pendingEditorFocusRequest, {
      fileId: pane.file.id,
      worktreeId: pane.file.worktreeId,
      viewStateId: pane.viewStateId
    })
      ? s.pendingEditorFocusRequest
      : null
  )
  const consumeEditorFocusRequest = useAppStore((s) => s.consumeEditorFocusRequest)

  useEffect(() => {
    if (!request) {
      return
    }
    const active = document.activeElement
    // Why: a slow load must not pull focus back from wherever the user went after the open.
    const focusStayed =
      active === null || active === document.body || active === request.focusedAtOpen?.deref()
    if (focusStayed && request.expiresAt > Date.now()) {
      targetRef.current?.focus({ preventScroll: true })
    }
    consumeEditorFocusRequest(request.token)
  }, [consumeEditorFocusRequest, request, targetRef])
}
