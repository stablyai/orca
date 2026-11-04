import type { AppState } from '@/store/types'

// Why frozen: the sidebar row model is always mounted and this list is empty
// almost always, so one shared identity serves every read.
export const EMPTY_PENDING_WORKTREE_CREATION_KEYS: string[] = Object.freeze(
  []
) as unknown as string[]

const keysBySource = new WeakMap<object, string[]>()

/** Cache creationId/repoId keys per slice; split on the first space because UUID creation IDs cannot contain spaces. */
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
