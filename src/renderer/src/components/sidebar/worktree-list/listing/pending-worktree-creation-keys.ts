import type { AppState } from '@/store/types'

// Why frozen: the sidebar row model is always mounted and this list is empty
// almost always, so one shared identity serves every read.
export const EMPTY_PENDING_WORKTREE_CREATION_KEYS: string[] = Object.freeze(
  []
) as unknown as string[]

const keysBySource = new WeakMap<object, string[]>()

/**
 * Flat `"<creationId> <repoId>"` keys for the pending-creation sidebar rows.
 *
 * Why identity-cached: this runs inside an always-mounted subscriber, so an
 * unmemoized `Object.values(...).map(...)` allocated an array plus one template
 * string per pending creation on every store write in the app. Keyed on the
 * slice reference, so it only rebuilds when the slice itself is replaced.
 *
 * Split on the first space — creationId is a UUID (no space) so a
 * space-containing repoId stays intact.
 */
export function selectPendingWorktreeCreationKeys(
  pendingWorktreeCreations: AppState['pendingWorktreeCreations'] | undefined
): string[] {
  if (!pendingWorktreeCreations) {
    return EMPTY_PENDING_WORKTREE_CREATION_KEYS
  }
  const cached = keysBySource.get(pendingWorktreeCreations)
  if (cached) {
    return cached
  }
  const creations = Object.values(pendingWorktreeCreations)
  const keys =
    creations.length === 0
      ? EMPTY_PENDING_WORKTREE_CREATION_KEYS
      : creations.map((creation) => `${creation.creationId} ${creation.request.repoId}`)
  keysBySource.set(pendingWorktreeCreations, keys)
  return keys
}
