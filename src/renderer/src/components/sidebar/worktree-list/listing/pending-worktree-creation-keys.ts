import type { SidebarFeedDomains } from '../../../../../../shared/sidebar-list/sidebar-feed-domains'
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
      : creations.map(
          (creation) =>
            `${creation.creationId} ${creation.request.executionHostId ?? creation.request.workspaceRunContext?.hostId ?? 'local'}\0${creation.request.repoId}`
        )
  keysBySource.set(pendingWorktreeCreations, keys)
  return keys
}

/** Combine main’s shared creations with window-only preflight/server work and exclude locally completed requests. */
export function withWindowCreations(
  domains: SidebarFeedDomains,
  pendingCreationKeys: readonly string[],
  endedCreationIds: ReadonlySet<string>
): SidebarFeedDomains {
  let creations: Map<string, { repoId: string }> | null = null
  for (const creationId of endedCreationIds) {
    if (domains.creations.has(creationId)) {
      creations ??= new Map(domains.creations)
      creations.delete(creationId)
    }
  }
  for (const key of pendingCreationKeys) {
    const separator = key.indexOf(' ')
    const creationId = key.slice(0, separator)
    if (!domains.creations.has(creationId)) {
      creations ??= new Map(domains.creations)
      creations.set(creationId, { repoId: key.slice(key.indexOf('\0', separator) + 1) })
    }
  }
  return creations ? { ...domains, creations } : domains
}
