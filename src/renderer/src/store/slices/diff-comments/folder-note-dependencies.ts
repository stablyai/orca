import type { DiffCommentOwner } from './diff-comment-owner'
import { diffCommentOwnerKey } from './diff-comment-owner'
import { diffCommentVersion } from '../../../../../shared/file-review/folder-diff-comment-merge'
import {
  latestQueuedActionsTouching,
  type FolderNoteAction,
  type FolderNoteScope
} from './folder-note-actions'
import {
  acceptedNote,
  isCurrentCopy,
  protectedCopies,
  type ProtectedCopy
} from './folder-note-protected-copy'

/** Whether what the host is known to hold for `id` already gives the dependent what it asked for. */
function holdsAnyway(
  copy: ProtectedCopy | null,
  scope: FolderNoteScope | undefined,
  id: string,
  earlier: FolderNoteAction
): boolean {
  // Only host evidence counts: a floor or the display cannot show what the host holds. The earlier
  // action's own verdict comes first (it outlives the copy, and a version it saw win outranks an
  // older sample); without one, the copy's evidence, which a later observation may supply.
  const accepted =
    earlier.held?.get(id) ?? (copy ? acceptedNote(copy, id) : ({ known: false } as const))
  if (!accepted.known) {
    return false
  }
  const sameVersion =
    diffCommentVersion(accepted.note) === diffCommentVersion(earlier.delta.get(id))
  switch (scope?.holds ?? 'version') {
    case 'cleared':
      return !accepted.note || !scope?.matches(id, accepted.note)
    case 'sent':
      return !accepted.note || sameVersion
    default:
      return sameVersion
  }
}

/**
 * Ids an action rests on that did not end as it needs: the latest earlier action changing the id
 * was not confirmed, and the host is not known to hold what the dependent asked for anyway (a peer
 * may have made the same change). Reads settled results only, so it never yields.
 */
export function unmetDependencies(
  copy: ProtectedCopy | null,
  borrowed: ReadonlyMap<string, FolderNoteAction>,
  scope: FolderNoteScope | undefined
): string[] {
  return [...borrowed]
    .filter(
      ([id, earlier]) => !earlier.satisfied?.has(id) && !holdsAnyway(copy, scope, id, earlier)
    )
    .map(([id]) => id)
}

/**
 * For a protected copy, whether the queued actions that make a no-op look like one took effect,
 * judged per id by the latest queued action that changed it; true at once for an empty scope.
 */
export async function awaitProtectedFolderNoteDependency(
  owner: DiffCommentOwner,
  scope: FolderNoteScope
): Promise<boolean> {
  const copyKey = diffCommentOwnerKey(owner)
  const copy = protectedCopies.get(copyKey)
  if (owner.kind !== 'folder' || !copy) {
    return true
  }
  const shown = new Map((copy.shown ?? []).map((note) => [note.id, note]))
  const borrowed = latestQueuedActionsTouching(copyKey, scope, { shown })
  await Promise.all([...borrowed.values()].map((action) => action.outcome))
  // A row replaced meanwhile is not the one the user acted on. A copy merely released keeps only
  // what each earlier action's own verdict said.
  if (copy.retired) {
    return false
  }
  return unmetDependencies(isCurrentCopy(copy) ? copy : null, borrowed, scope).length === 0
}
