import type { PendingEditorFocusRequest } from '@/store/slices/editor'

/** Match viewStateId as well as file/workspace so exactly one split pane claims the focus handoff. */
export function matchesPendingEditorFocusRequest(
  request: PendingEditorFocusRequest | null | undefined,
  pane: { fileId: string; worktreeId: string | undefined; viewStateId: string | undefined }
): boolean {
  if (!request || pane.worktreeId === undefined || pane.viewStateId === undefined) {
    return false
  }
  return (
    request.fileId === pane.fileId &&
    request.worktreeId === pane.worktreeId &&
    request.viewStateId === pane.viewStateId
  )
}
