import type { Repo } from '../../../../shared/repo-types'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session-state-types'
import type { DetectedWorktreeListResult, Worktree } from '../../../../shared/worktree/types'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import { getRepoIdFromWorktreeId } from '../../../../shared/worktree/id'

type WorktreeValidityCatalog = {
  repos: readonly Pick<Repo, 'id'>[]
  worktreesByRepo: Readonly<Record<string, readonly Pick<Worktree, 'id'>[]>>
  detectedWorktreesByRepo?: Readonly<
    Record<string, Pick<DetectedWorktreeListResult, 'authoritative' | 'worktrees'> | undefined>
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
  const detectedWorktreesByRepo = catalog.detectedWorktreesByRepo ?? {}
  const repoIdsWithLoadedWorktrees = new Set(
    Object.entries(worktreesByRepo)
      // Why (#1158): a metadata fallback can be non-empty yet partial (host-less metas are skipped on
      // multi-owner repos, agent-scratch stays hidden), so it cannot prove deletion the way a real listing can.
      // Only an explicitly non-authoritative result is disqualified; a repo with no detection entry at all
      // still counts as loaded, as before.
      .filter(
        ([repoId, worktrees]) =>
          worktrees.length > 0 && detectedWorktreesByRepo[repoId]?.authoritative !== false
      )
      .map(([repoId]) => repoId)
  )
  const repoIdsWithAuthoritativeDetectedWorktrees = new Set(
    Object.entries(detectedWorktreesByRepo)
      .filter(([, detected]) => detected?.authoritative)
      .map(([repoId]) => repoId)
  )
  // Why (#15227): worktreesByRepo is the sidebar catalog, which drops worktrees hidden by
  // visibility settings; an authoritative scan still lists them. Detection, not display, is
  // the existence signal — otherwise hiding a worktree reads as deleting it.
  const authoritativelyDetectedWorktreeIds = new Set(
    Object.values(detectedWorktreesByRepo).flatMap((detected) =>
      detected?.authoritative ? detected.worktrees.map((worktree) => worktree.id) : []
    )
  )

  for (const worktreeId of persistedWorktreeIds) {
    if (validWorktreeIds.has(worktreeId) || parseWorkspaceKey(worktreeId)?.type === 'folder') {
      continue
    }
    if (authoritativelyDetectedWorktreeIds.has(worktreeId)) {
      validWorktreeIds.add(worktreeId)
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
