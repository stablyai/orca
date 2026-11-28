import type { AppState } from '../../types'
import type { DiffComment } from '../../../../../shared/file-review/diff-comment-types'
import { findCopyRows } from './worktree-diff-comments-selector'
import { findOwnedFolder, type DiffCommentOwner } from './diff-comment-owner'
import { readDiffCommentsFromHost } from './diff-comment-host-write'

// Why: a failed write may still have landed, so until a write succeeds this copy can't name what the host holds.
// The ids are every note this copy listed or tried to write since: only those are its to change on the host.
const ownNoteIdsAfterFailure = new Map<string, { owner: DiffCommentOwner; ids: Set<string> }>()

function hasOwnedCopy(state: AppState, owner: DiffCommentOwner): boolean {
  if (owner.kind === 'folder') {
    return findOwnedFolder(state, owner) !== null
  }
  return findCopyRows(state, owner.worktreeId, owner.authority).length > 0
}

export function resolveDiffCommentsBaseAfterFailure(args: {
  floorKey: string
  owner: DiffCommentOwner
  floor: DiffComment[]
  requested: DiffComment[]
  normalize: (comment: DiffComment) => DiffComment
}): DiffComment[] | undefined | Promise<DiffComment[]> {
  const { floorKey, owner, floor, requested, normalize } = args
  const own = ownNoteIdsAfterFailure.get(floorKey)?.ids
  if (!own) {
    return floor
  }
  if (owner.kind !== 'worktree') {
    return undefined
  }
  return readDiffCommentsFromHost(owner).then((held) => {
    const mine = new Set([...own, ...[...floor, ...requested].map((note) => note.id)])
    return held.filter((note) => mine.has(note.id)).map(normalize)
  })
}

export function clearDiffCommentFailureOwner(floorKey: string): void {
  ownNoteIdsAfterFailure.delete(floorKey)
}

export function recordDiffCommentFailureOwner(args: {
  state: AppState
  floorKey: string
  owner: DiffCommentOwner
  writeAttempted: boolean
  floor: readonly DiffComment[]
  sent: readonly DiffComment[]
}): void {
  const { state, floorKey, owner, writeAttempted, floor, sent } = args
  // Drop entries for copies that have left the store (e.g. host catalog sync without explicit remove).
  for (const [key, entry] of ownNoteIdsAfterFailure) {
    if (!hasOwnedCopy(state, entry.owner)) {
      ownNoteIdsAfterFailure.delete(key)
    }
  }
  if (!writeAttempted || !hasOwnedCopy(state, owner)) {
    ownNoteIdsAfterFailure.delete(floorKey)
    return
  }
  const own = ownNoteIdsAfterFailure.get(floorKey)?.ids ?? new Set<string>()
  if (owner.kind === 'worktree') {
    for (const note of [...floor, ...sent]) {
      own.add(note.id)
    }
  }
  ownNoteIdsAfterFailure.set(floorKey, { owner, ids: own })
}

/** Retires failed-write note tracking for removed worktrees and folder workspaces. */
export function forgetDiffCommentFailureOwners(worktreeIds: Iterable<string>): void {
  const removed = worktreeIds instanceof Set ? worktreeIds : new Set(worktreeIds)
  if (removed.size === 0 || ownNoteIdsAfterFailure.size === 0) {
    return
  }
  for (const [key, entry] of ownNoteIdsAfterFailure) {
    if (removed.has(entry.owner.worktreeId)) {
      ownNoteIdsAfterFailure.delete(key)
    }
  }
}
