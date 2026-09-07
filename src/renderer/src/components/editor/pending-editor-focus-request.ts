import type { PendingEditorFocusRequest } from '@/store/slices/editor'

/**
 * True when an explicit open focus handoff belongs to this editor pane. Both the rich Markdown and
 * Monaco surfaces gate on this, so a handoff is claimed (and retired) by exactly one pane — split
 * siblings share a file id, and only `viewStateId` tells them apart.
 */
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
