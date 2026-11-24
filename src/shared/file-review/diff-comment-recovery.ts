import { z } from 'zod'
import type { DiffComment } from './diff-comment-types'
import { applyDiffCommentWrite, type DiffCommentBaseMutation } from './diff-comment-mutation'
import { sha256 } from '../hashing/sha256'
import { bytesToHex } from '../hashing/orca-hook-content-hash'

// Stands for "this note was not in the list"; a digest is never empty.
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
 * Sent with a save after a failed one. For each note id, every version the writer may have left on
 * the host since its last confirmed save: the list it confirmed and every list it sent whose reply
 * failed (a failed write may have landed). An id not listed was absent from all of them.
 */
export type DiffCommentRecovery = { known: { id: string; versions: string[] }[] }

export const DiffCommentRecoverySchema = z.object({
  known: z
    .array(
      z.object({
        id: z.string().min(1),
        versions: z
          .array(z.union([z.literal(ABSENT_NOTE_VERSION), z.string().regex(/^[0-9a-f]{64}$/)]))
          .max(1024)
      })
    )
    .max(10_000)
})

/** Mutation-only; never persisted with workspace metadata. */
export type DiffCommentRecoveryMutation = {
  diffCommentsRecovery?: DiffCommentRecovery
}

/**
 * The list a recovering save leaves, decided per note against what the host holds at this moment.
 * The writer edited a note when the version it now shows is not one it knew; a host version it
 * knew is its own, and a host version outside those is another device's.
 * - Host holds a version the writer knew: the writer's view applies (edit, add or delete). So a
 *   landed add whose reply was lost is removed only while the host still holds that exact version.
 * - Another device changed, added or deleted it and the writer did not edit it: that change stays.
 * - Both changed it: the rule of a save without a failure, so the writer's edit or delete wins
 *   over another device's edit, and another device's delete wins over the writer's edit.
 */
export function applyDiffCommentRecovery(
  current: readonly DiffComment[],
  requested: readonly DiffComment[],
  recovery: DiffCommentRecovery
): DiffComment[] {
  const knownById = new Map(recovery.known.map(({ id, versions }) => [id, new Set(versions)]))
  const isKnown = (id: string, note: DiffComment | undefined): boolean => {
    const versions = knownById.get(id)
    return versions ? versions.has(diffCommentVersion(note)) : note === undefined
  }
  const requestedById = new Map(requested.map((note) => [note.id, note]))
  const intended = (id: string, onHost: DiffComment | undefined): DiffComment | undefined => {
    const shown = requestedById.get(id)
    if (isKnown(id, onHost)) {
      return shown
    }
    if (isKnown(id, shown)) {
      return onHost
    }
    return onHost ? shown : undefined
  }
  const currentIds = new Set(current.map((note) => note.id))
  return [
    ...current.flatMap((note) => intended(note.id, note) ?? []),
    ...requested.flatMap((note) =>
      currentIds.has(note.id) ? [] : (intended(note.id, undefined) ?? [])
    )
  ]
}

/** The list a folder's note write leaves: a recovery when one is sent, otherwise the base merge. */
export function applyFolderDiffCommentWrite(
  current: readonly DiffComment[] | undefined,
  updates: { diffComments?: DiffComment[] } & DiffCommentBaseMutation & DiffCommentRecoveryMutation
): DiffComment[] | undefined {
  const { diffComments, diffCommentsRecovery } = updates
  return diffComments && diffCommentsRecovery
    ? applyDiffCommentRecovery(current ?? [], diffComments, diffCommentsRecovery)
    : applyDiffCommentWrite(current, updates)
}
