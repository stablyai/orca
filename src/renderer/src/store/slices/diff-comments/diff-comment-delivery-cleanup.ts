import type { StateCreator } from 'zustand'
import type { AppState } from '../../types'
import type { DiffComment } from '../../../../../shared/file-review/diff-comment-types'
import {
  matchesDeliveredDiffComment,
  type DiffCommentDeliverySnapshot
} from '../../../../../shared/file-review/diff-comment-mutation'
import { readOwnedDiffComments, type DiffCommentOwner } from './diff-comment-owner'
import { writeDiffCommentsToHost } from './diff-comment-host-write'
import {
  enqueueDiffCommentHostWrite,
  reconcileDiffCommentQueueFloor
} from './diff-comment-persistence'

/** The host answered without removing a delivered note it still holds unchanged. */
export class DeliveredCleanupNotAppliedError extends Error {
  constructor() {
    super('The workspace host kept the delivered review notes; it may not support removing them.')
  }
}

export function enqueueDeliveredDiffCommentCleanup(
  set: Parameters<StateCreator<AppState>>[0],
  get: () => AppState,
  owner: DiffCommentOwner,
  snapshots: readonly DiffCommentDeliverySnapshot[]
): Promise<void> {
  return enqueueDiffCommentHostWrite(owner, async () => {
    if (!readOwnedDiffComments(get(), owner)) {
      throw new Error('The workspace copy is gone; review notes were not saved.')
    }
    // Send only the conditional command so older hosts cannot mistake it for a list replacement.
    const saved = await writeDiffCommentsToHost(owner, { deliveredDiffCommentSnapshots: snapshots })
    if (!saved) {
      throw new Error('The workspace host did not return its review notes.')
    }
    // Why: a host that processed the command never answers with an unchanged delivered note; one that
    // dropped the unknown field (older host, stripped transport) answers with it, which is not success.
    if (saved.some((note) => snapshots.some((s) => matchesDeliveredDiffComment(note, s)))) {
      throw new DeliveredCleanupNotAppliedError()
    }
    const expected = new Map(snapshots.map((note) => [note.id, note]))
    const authoritative = new Map(saved.map((note) => [note.id, note]))
    const reconcile = (notes: DiffComment[]): DiffComment[] | null => {
      let changed = false
      const next = notes.flatMap((note) => {
        const snapshot = expected.get(note.id)
        if (!snapshot || !matchesDeliveredDiffComment(note, snapshot)) {
          return [note]
        }
        changed = true
        const current = authoritative.get(note.id)
        return current ? [current] : []
      })
      return changed ? next : null
    }
    reconcileDiffCommentQueueFloor(set, owner, reconcile)
  })
}
