import type {
  DetectedWorktreeListResult,
  Repo,
  WorkspaceSessionState,
  Worktree
} from '../../../../shared/types'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import { getRepoIdFromWorktreeId } from '../../../../shared/worktree-id'

type WorktreeValidityCatalog = {
  repos: readonly Pick<Repo, 'id'>[]
  worktreesByRepo: Readonly<Record<string, readonly Pick<Worktree, 'id'>[]>>
  detectedWorktreesByRepo?: Readonly<
    Record<string, Pick<DetectedWorktreeListResult, 'authoritative'> | undefined>
  >
}

export function collectPersistedWorktreeIdsForSessionHydration(
  session: WorkspaceSessionState
): Set<string> {
  const persistedWorktreeIds = new Set<string>()
  for (const worktreeId of Object.keys(session.tabsByWorktree)) {
    persistedWorktreeIds.add(worktreeId)
  }
  for (const worktreeId of Object.keys(session.unifiedTabs ?? {})) {
    persistedWorktreeIds.add(worktreeId)
  }
  for (const worktreeId of Object.keys(session.openFilesByWorktree ?? {})) {
    persistedWorktreeIds.add(worktreeId)
  }
  for (const worktreeId of Object.keys(session.browserTabsByWorktree ?? {})) {
    persistedWorktreeIds.add(worktreeId)
  }
  return persistedWorktreeIds
}

export function buildValidWorktreeIdsForSessionHydration(
  catalog: WorktreeValidityCatalog,
  persistedWorktreeIds: Iterable<string>
): Set<string> {
  const worktreesByRepo = catalog.worktreesByRepo
  const validWorktreeIds = new Set(
    Object.values(worktreesByRepo)
      .flat()
      .map((worktree) => worktree.id)
  )
  const knownRepoIds = new Set(catalog.repos.map((repo) => repo.id))
  const repoIdsWithLoadedWorktrees = new Set(
    Object.entries(worktreesByRepo)
      .filter(([, worktrees]) => worktrees.length > 0)
      .map(([repoId]) => repoId)
  )
  const repoIdsWithAuthoritativeDetectedWorktrees = new Set(
    Object.entries(catalog.detectedWorktreesByRepo ?? {})
      .filter(([, detected]) => detected?.authoritative)
      .map(([repoId]) => repoId)
  )

  for (const worktreeId of persistedWorktreeIds) {
    if (validWorktreeIds.has(worktreeId) || parseWorkspaceKey(worktreeId)?.type === 'folder') {
      continue
    }
    const repoId = getRepoIdFromWorktreeId(worktreeId)
    // Why (#1158): a failed scan cannot prove deletion, while loaded worktrees or an authoritative scan can.
    if (
      knownRepoIds.has(repoId) &&
      !repoIdsWithLoadedWorktrees.has(repoId) &&
      !repoIdsWithAuthoritativeDetectedWorktrees.has(repoId)
    ) {
      validWorktreeIds.add(worktreeId)
    }
  }

  return validWorktreeIds
}
