import * as z from 'zod'
import type { DiffComment } from './diff-comment-types'
import { DiffCommentSchema } from './diff-comment-schema'
import { sha256 } from '../hashing/sha256'
import { bytesToHex } from '../hashing/orca-hook-content-hash'

// Stands for "no note with this id"; a digest is never empty.
export const ABSENT_NOTE_VERSION = ''

/** A note's exact content as a digest; sorted keys and dropped undefineds, so field order never matters. */
export function diffCommentVersion(note: DiffComment | undefined): string {
  if (!note) {
    return ABSENT_NOTE_VERSION
  }
  const entries = Object.entries(note)
    .filter(([, value]) => value !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(entries))))
}

/**
 * One folder note change for a host that only merges, never replaces: `diffCommentsBase` holds the
 * touched notes as they were before, `diffComments` as they are after; every other note is left as
 * stored. `read` asks for the row's notes without changing anything.
 */
export const FolderDiffCommentMergeRequestSchema = z
  .object({
    requestId: z.string().min(1).max(128),
    folderWorkspaceId: z.string().min(1),
    // The row's incarnation when the action was made; a recreated row with the same id is refused.
    expectedCreatedAt: z.number().finite(),
    mode: z.enum(['merge', 'read']),
    diffCommentsBase: z.array(DiffCommentSchema),
    diffComments: z.array(DiffCommentSchema)
  })
  .refine(
    (request) =>
      request.mode === 'merge' ||
      (request.diffCommentsBase.length === 0 && request.diffComments.length === 0),
    { message: 'A read carries no notes' }
  )

export type FolderDiffCommentMergeRequest = z.infer<typeof FolderDiffCommentMergeRequestSchema>

/** For each touched id, the version the host holds right after the operation. */
export type FolderDiffCommentVerdict = { id: string; version: string }[]

export type FolderDiffCommentRefusal =
  | 'not_found'
  | 'incarnation_changed'
  | 'duplicate_row'
  | 'ambiguous_note_ids'
  | 'refused'

/** Captured inside the host's synchronous operation, so it describes exactly that commit. */
export type FolderDiffCommentReceipt =
  | {
      outcome: 'applied' | 'read'
      requestId: string
      folderWorkspaceId: string
      createdAt: number
      updatedAt: number
      verdict: FolderDiffCommentVerdict
      // The row's whole note list, only when it fits the reply budget.
      snapshot?: DiffComment[]
    }
  | { outcome: FolderDiffCommentRefusal; requestId: string; folderWorkspaceId: string }

// Why: paired replies are capped at 4 MiB of JSON; keep the snapshot well inside with the envelope.
export const FOLDER_DIFF_COMMENT_SNAPSHOT_MAX_BYTES = 3 * 1024 * 1024

export function utf8JsonByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length
}

export function touchedNoteIds(request: FolderDiffCommentMergeRequest): string[] {
  return [...new Set([...request.diffCommentsBase, ...request.diffComments].map((note) => note.id))]
}

function hasRepeatedId(notes: readonly DiffComment[], ids?: ReadonlySet<string>): boolean {
  const seen = new Set<string>()
  for (const note of notes) {
    if (ids && !ids.has(note.id)) {
      continue
    }
    if (seen.has(note.id)) {
      return true
    }
    seen.add(note.id)
  }
  return false
}

/** A touched id that appears twice, in the request or on the host, names no single note to change. */
export function hasAmbiguousTouchedIds(
  request: FolderDiffCommentMergeRequest,
  stored: readonly DiffComment[]
): boolean {
  return (
    hasRepeatedId(request.diffCommentsBase) ||
    hasRepeatedId(request.diffComments) ||
    hasRepeatedId(stored, new Set(touchedNoteIds(request)))
  )
}

export function verdictFor(
  notes: readonly DiffComment[],
  ids: readonly string[]
): FolderDiffCommentVerdict {
  const byId = new Map(notes.map((note) => [note.id, note]))
  return ids.map((id) => ({ id, version: diffCommentVersion(byId.get(id)) }))
}

/** A copy of the notes for the receipt, or none when they would not fit the reply. */
// Why measure first: an oversized row is never copied just to be dropped.
export function snapshotWithinBudget(notes: readonly DiffComment[]): DiffComment[] | undefined {
  return utf8JsonByteLength(notes) <= FOLDER_DIFF_COMMENT_SNAPSHOT_MAX_BYTES
    ? notes.map((note) => ({ ...note }))
    : undefined
}
