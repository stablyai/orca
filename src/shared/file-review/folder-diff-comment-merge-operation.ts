import type { DiffComment } from './diff-comment-types'
import type { FolderWorkspace } from '../folder-workspaces/folder-workspace-types'
import {
  hasAmbiguousTouchedIds,
  snapshotWithinBudget,
  touchedNoteIds,
  verdictFor,
  type FolderDiffCommentMergeRequest,
  type FolderDiffCommentReceipt
} from './folder-diff-comment-merge'

/** What the operation needs from a host's store; local IPC and the paired runtime each supply one. */
export type FolderDiffCommentMergeHost = {
  /** Every stored row, hidden ones included, so a duplicate id is never missed. */
  rows: () => readonly FolderWorkspace[]
  /** The rows this host shows clients; a hidden row is never written through this operation. */
  visibleRows: () => readonly FolderWorkspace[]
  /** Throws when a guard (such as a WSL move) refuses a note write to this row. */
  assertWritable: (row: FolderWorkspace) => void
  update: (
    folderWorkspaceId: string,
    updates: { diffComments: DiffComment[]; diffCommentsBase: DiffComment[] }
  ) => FolderWorkspace | null
  notify: () => void
}

/**
 * Applies one merge-only note change, or reads the notes, and answers with a receipt captured in
 * the same synchronous step: nothing can change the row between the checks, the write and the
 * verdict. Every refusal happens before the row is touched.
 */
export function mergeFolderDiffCommentsOnHost(
  host: FolderDiffCommentMergeHost,
  request: FolderDiffCommentMergeRequest
): FolderDiffCommentReceipt {
  const { requestId, folderWorkspaceId } = request
  const refuse = (outcome: Exclude<FolderDiffCommentReceipt['outcome'], 'applied' | 'read'>) =>
    ({ outcome, requestId, folderWorkspaceId }) as const
  const matches = host.rows().filter((row) => row.id === folderWorkspaceId)
  if (matches.length > 1) {
    return refuse('duplicate_row')
  }
  const row = matches[0]
  if (!row || !host.visibleRows().some((visible) => visible.id === folderWorkspaceId)) {
    return refuse('not_found')
  }
  if (row.createdAt !== request.expectedCreatedAt) {
    return refuse('incarnation_changed')
  }
  const stored = row.diffComments ?? []
  if (hasAmbiguousTouchedIds(request, stored)) {
    return refuse('ambiguous_note_ids')
  }
  const ids = touchedNoteIds(request)
  if (request.mode === 'read') {
    return {
      outcome: 'read',
      requestId,
      folderWorkspaceId,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      verdict: verdictFor(stored, ids),
      snapshot: snapshotWithinBudget(stored)
    }
  }
  try {
    host.assertWritable(row)
  } catch {
    return refuse('refused')
  }
  const updated = host.update(folderWorkspaceId, {
    diffComments: request.diffComments,
    diffCommentsBase: request.diffCommentsBase
  })
  if (!updated) {
    return refuse('not_found')
  }
  const notes = updated.diffComments ?? []
  const receipt: FolderDiffCommentReceipt = {
    outcome: 'applied',
    requestId,
    folderWorkspaceId,
    createdAt: updated.createdAt,
    updatedAt: updated.updatedAt,
    verdict: verdictFor(notes, ids),
    snapshot: snapshotWithinBudget(notes)
  }
  host.notify()
  return receipt
}
