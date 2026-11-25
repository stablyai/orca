import * as z from 'zod'
import type { DiffComment } from '../../../../../shared/file-review/diff-comment-types'
import { DiffCommentSchema } from '../../../../../shared/file-review/diff-comment-schema'
import {
  ABSENT_NOTE_VERSION,
  diffCommentVersion,
  type FolderDiffCommentMergeRequest,
  type FolderDiffCommentVerdict
} from '../../../../../shared/file-review/folder-diff-comment-merge'
import { parseWorkspaceKey } from '../../../../../shared/workspace/identity/workspace-scope'
import type { FolderNoteAction, FolderOwner } from './folder-note-actions'

const HostReceiptSchema = z.object({
  outcome: z.enum(['applied', 'read']),
  requestId: z.string(),
  folderWorkspaceId: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  verdict: z.array(z.object({ id: z.string(), version: z.string() })),
  snapshot: z.unknown().optional()
})

const SnapshotSchema = z.array(DiffCommentSchema)

/** A receipt this client checked: it answers this request, for this row incarnation. */
export type CheckedFolderNoteReceipt = {
  verdict: FolderDiffCommentVerdict
  /** The row's whole note list; absent when the host left it out or it did not parse. */
  snapshot: DiffComment[] | undefined
}

export function folderNoteRequest(
  owner: FolderOwner,
  action: Pick<FolderNoteAction, 'seq' | 'delta' | 'before'>,
  mode: 'merge' | 'read',
  expectedCreatedAt: number
): FolderDiffCommentMergeRequest {
  const scope = parseWorkspaceKey(owner.worktreeId)
  const folderWorkspaceId = scope?.type === 'folder' ? scope.folderWorkspaceId : owner.worktreeId
  return {
    requestId: `folder-notes-${action.seq}-${mode}-${Date.now().toString(36)}`,
    folderWorkspaceId,
    expectedCreatedAt,
    mode,
    diffCommentsBase:
      mode === 'read' ? [] : [...action.before.values()].filter((note) => note !== undefined),
    diffComments:
      mode === 'read' ? [] : [...action.delta.values()].filter((note) => note !== undefined)
  }
}

/** The checked receipt, or null when the reply is not a valid answer to this exact request. */
export function checkFolderNoteReceipt(
  reply: unknown,
  request: FolderDiffCommentMergeRequest
): CheckedFolderNoteReceipt | null {
  const parsed = HostReceiptSchema.safeParse(reply)
  if (!parsed.success) {
    return null
  }
  const receipt = parsed.data
  if (
    receipt.requestId !== request.requestId ||
    receipt.folderWorkspaceId !== request.folderWorkspaceId ||
    receipt.outcome !== (request.mode === 'merge' ? 'applied' : 'read') ||
    receipt.createdAt !== request.expectedCreatedAt
  ) {
    return null
  }
  const named = new Set(receipt.verdict.map((entry) => entry.id))
  const touched = [...request.diffCommentsBase, ...request.diffComments].map((note) => note.id)
  if (named.size !== receipt.verdict.length || !touched.every((id) => named.has(id))) {
    return null
  }
  const snapshot =
    receipt.snapshot === undefined ? undefined : SnapshotSchema.safeParse(receipt.snapshot)
  return {
    verdict: receipt.verdict,
    snapshot: snapshot?.success ? snapshot.data : undefined
  }
}

/** A refusal names its request: the host checked before touching the row. */
export function isDefinitiveRefusalReply(
  reply: unknown,
  request: FolderDiffCommentMergeRequest
): string | null {
  if (typeof reply !== 'object' || reply === null) {
    return null
  }
  const { outcome, requestId } = reply as { outcome?: unknown; requestId?: unknown }
  return typeof outcome === 'string' &&
    outcome !== 'applied' &&
    outcome !== 'read' &&
    requestId === request.requestId
    ? outcome
    : null
}

function onlySentAtChanged(before: DiffComment | undefined, after: DiffComment | undefined) {
  if (!before || !after) {
    return false
  }
  return (
    diffCommentVersion({ ...before, sentAt: undefined }) ===
    diffCommentVersion({ ...after, sentAt: undefined })
  )
}

/** Whether the host holds what this action meant for every id it changed. */
export function folderNoteActionSatisfied(
  action: FolderNoteAction,
  verdict: FolderDiffCommentVerdict
): boolean {
  const held = new Map(verdict.map((entry) => [entry.id, entry.version]))
  return [...action.delta].every(([id, intended]) => {
    const version = held.get(id)
    if (version === diffCommentVersion(intended)) {
      return true
    }
    // Marking a note sent has nothing left to do once another device deleted it.
    return version === ABSENT_NOTE_VERSION && onlySentAtChanged(action.before.get(id), intended)
  })
}
