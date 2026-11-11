import type { AppState } from '@/store/types'
import { pendingWorktreeCreationIsVisible } from '@/lib/workspace/creation/pending-worktree-creation'

// Why frozen: the sidebar row model is always mounted and this list is empty
// almost always, so one shared identity serves every read.
export const EMPTY_PENDING_WORKTREE_CREATION_KEYS: string[] = Object.freeze(
  []
) as unknown as string[]

const keysBySource = new WeakMap<object, { visible: string[]; hidden: string[] }>()

/** Cache creationId/repoId keys per slice; split on the first space because UUID creation IDs cannot contain spaces. */
export function selectPendingWorktreeCreationKeys(
  pendingWorktreeCreations: AppState['pendingWorktreeCreations'] | undefined,
  visibility: 'visible' | 'hidden' = 'visible'
): string[] {
  if (!pendingWorktreeCreations) {
    return EMPTY_PENDING_WORKTREE_CREATION_KEYS
  }
  const cached = keysBySource.get(pendingWorktreeCreations)
  if (cached) {
    return cached[visibility]
  }
  const keys: { visible: string[]; hidden: string[] } = { visible: [], hidden: [] }
  for (const creation of Object.values(pendingWorktreeCreations)) {
    keys[pendingWorktreeCreationIsVisible(creation) ? 'visible' : 'hidden'].push(
      `${creation.creationId} ${creation.request.executionHostId ?? creation.request.workspaceRunContext?.hostId ?? 'local'}\0${creation.request.repoId}`
    )
  }
  if (keys.visible.length === 0) {
    keys.visible = EMPTY_PENDING_WORKTREE_CREATION_KEYS
  }
  if (keys.hidden.length === 0) {
    keys.hidden = EMPTY_PENDING_WORKTREE_CREATION_KEYS
  }
  keysBySource.set(pendingWorktreeCreations, keys)
  return keys[visibility]
}

export function decodePendingWorktreeCreationKeys(pendingCreationKeys: readonly string[]) {
  return pendingCreationKeys.map((key) => {
    const separator = key.indexOf(' ')
    return {
      creationId: key.slice(0, separator),
      repoId: key.slice(key.indexOf('\0', separator) + 1),
      hostId: key.slice(separator + 1, key.indexOf('\0', separator))
    }
  })
}

export function getPendingCreationHostById(pendingCreationKeys: readonly string[]) {
  return new Map(
    decodePendingWorktreeCreationKeys(pendingCreationKeys).map((key) => [
      key.creationId,
      key.hostId
    ])
  )
}
