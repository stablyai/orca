import * as z from 'zod'
import type { DiffComment } from '../../../../../shared/file-review/diff-comment-types'
import { DiffCommentSchema } from '../../../../../shared/file-review/diff-comment-schema'
import {
  ABSENT_NOTE_VERSION,
  diffCommentVersion,
  touchedNoteIds,
  verdictFor,
  type FolderDiffCommentMergeRequest,
  type FolderDiffCommentRefusal,
  type FolderDiffCommentVerdict
} from '../../../../../shared/file-review/folder-diff-comment-merge'
import { parseWorkspaceKey } from '../../../../../shared/workspace/identity/workspace-scope'
import type { FolderNoteAction, FolderOwner } from './folder-note-actions'

// A version is the absent marker or a SHA-256 hex digest; anything else is not from a real host.
const NoteVersionSchema = z.union([
  z.literal(ABSENT_NOTE_VERSION),
  z.string().regex(/^[0-9a-f]{64}$/)
])

const HostReceiptSchema = z.object({
  outcome: z.enum(['applied', 'read']),
  requestId: z.string(),
  folderWorkspaceId: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  verdict: z.array(z.object({ id: z.string(), version: NoteVersionSchema })),
  added: z.array(z.string()).optional(),
  snapshot: z.unknown().optional()
})

const REFUSALS: readonly FolderDiffCommentRefusal[] = [
  'not_found',
  'incarnation_changed',
  'duplicate_row',
  'ambiguous_note_ids',
  'refused'
]

const HostRefusalSchema = z.object({
  outcome: z.enum(REFUSALS as [FolderDiffCommentRefusal, ...FolderDiffCommentRefusal[]]),
  requestId: z.string(),
  folderWorkspaceId: z.string()
})

const SnapshotSchema = z.array(DiffCommentSchema)

/** A receipt this client checked: it answers this request, for this row incarnation. */
export type CheckedFolderNoteReceipt = {
  verdict: FolderDiffCommentVerdict
  /** Touched ids the host appended with this write; a note it already held keeps its place. */
  added: ReadonlySet<string>
  /** The row's whole note list; absent when the host left it out or it disagreed with the verdict. */
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

/** The snapshot, if it lists each id once and agrees with the verdict on every touched id. */
function consistentSnapshot(
  raw: unknown,
  ids: readonly string[],
  verdict: FolderDiffCommentVerdict
): DiffComment[] | undefined {
  const parsed = raw === undefined ? undefined : SnapshotSchema.safeParse(raw)
  if (!parsed?.success) {
    return undefined
  }
  const notes = parsed.data
  if (new Set(notes.map((note) => note.id)).size !== notes.length) {
    return undefined
  }
  const held = new Map(verdict.map((entry) => [entry.id, entry.version]))
  return verdictFor(notes, ids).every((entry) => held.get(entry.id) === entry.version)
    ? notes
    : undefined
}

/**
 * Whether the claimed appends are ones this request could make: a read places nothing; an append is
 * an id only in the requested after-list (never in its base: an edit stays in place), holding the
 * requested version; and a full snapshot ends with exactly those notes, in request order.
 */
function placementPossible(
  request: FolderDiffCommentMergeRequest,
  verdict: FolderDiffCommentVerdict,
  added: ReadonlySet<string>,
  snapshot: readonly DiffComment[] | undefined
): boolean {
  if (added.size === 0) {
    return true
  }
  if (request.mode === 'read') {
    return false
  }
  const inBase = new Set(request.diffCommentsBase.map((note) => note.id))
  const after = new Map(request.diffComments.map((note) => [note.id, note]))
  const held = new Map(verdict.map((entry) => [entry.id, entry.version]))
  const possible = [...added].every(
    (id) => !inBase.has(id) && after.has(id) && held.get(id) === diffCommentVersion(after.get(id))
  )
  if (!possible || !snapshot) {
    return possible
  }
  const appended = request.diffComments.filter((note) => added.has(note.id)).map((note) => note.id)
  const tail = snapshot.slice(snapshot.length - appended.length).map((note) => note.id)
  return appended.length <= snapshot.length && appended.every((id, index) => tail[index] === id)
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
  // The verdict names exactly the touched ids, each once.
  const touched = touchedNoteIds(request)
  const named = new Set(receipt.verdict.map((entry) => entry.id))
  if (
    named.size !== receipt.verdict.length ||
    named.size !== touched.length ||
    !touched.every((id) => named.has(id))
  ) {
    return null
  }
  const added = new Set(receipt.added ?? [])
  const snapshot = consistentSnapshot(receipt.snapshot, touched, receipt.verdict)
  if (
    added.size !== (receipt.added ?? []).length ||
    !placementPossible(request, receipt.verdict, added, snapshot)
  ) {
    return null
  }
  return {
    verdict: receipt.verdict,
    added,
    // An inconsistent snapshot is dropped; the verdict alone still settles the action.
    snapshot
  }
}

/** A known refusal bound to this request and row: the host checked before touching the row. */
export function isDefinitiveRefusalReply(
  reply: unknown,
  request: FolderDiffCommentMergeRequest
): FolderDiffCommentRefusal | null {
  const parsed = HostRefusalSchema.safeParse(reply)
  return parsed.success &&
    parsed.data.requestId === request.requestId &&
    parsed.data.folderWorkspaceId === request.folderWorkspaceId
    ? parsed.data.outcome
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

/** What a verdict says the host holds for one id: a note or absence, or another version unseen. */
export type HeldNote = { known: true; note: DiffComment | undefined } | { known: false }

/**
 * Per id, what the host holds as far as this action knows: its intended note, confirmed absence,
 * or unknown (another version won; this client has no copy of it). `satisfied` are the ids where
 * the host holds what the action meant.
 */
export function projectFolderNoteVerdict(
  action: Pick<FolderNoteAction, 'delta' | 'before'>,
  verdict: FolderDiffCommentVerdict
): {
  satisfied: ReadonlySet<string>
  held: Map<string, HeldNote>
} {
  const versions = new Map(verdict.map((entry) => [entry.id, entry.version]))
  const satisfied = new Set<string>()
  const held = new Map<string, HeldNote>()
  for (const [id, intended] of action.delta) {
    const version = versions.get(id)
    if (version === diffCommentVersion(intended)) {
      satisfied.add(id)
      held.set(id, { known: true, note: intended })
    } else if (version === ABSENT_NOTE_VERSION) {
      held.set(id, { known: true, note: undefined })
      // Marking a note sent has nothing left to do once another device deleted it.
      if (onlySentAtChanged(action.before.get(id), intended)) {
        satisfied.add(id)
      }
    } else {
      held.set(id, { known: false })
    }
  }
  return { satisfied, held }
}
