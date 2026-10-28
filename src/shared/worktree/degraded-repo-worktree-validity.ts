import type { Repo } from '../repo-types'
import type { WorkspaceSessionState } from '../workspace-session-state-types'
import type { DetectedWorktreeListResult, Worktree } from './types'
import { parseWorkspaceKey } from '../workspace-scope'
import { getRepoIdFromWorktreeId } from './id'

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
  const detectedWorktreesByRepo = catalog.detectedWorktreesByRepo ?? {}
  const repoIdsWithLoadedWorktrees = new Set(
    Object.entries(worktreesByRepo)
      // Metadata fallbacks can omit host-less/scratch rows and cannot prove deletion (#1158). Explicitly non-authoritative listings disqualify a repo; no detection entry preserves legacy loaded status.
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

  for (const worktreeId of persistedWorktreeIds) {
    if (validWorktreeIds.has(worktreeId) || parseWorkspaceKey(worktreeId)?.type === 'folder') {
      continue
    }
    const repoId = getRepoIdFromWorktreeId(worktreeId)
    // A failed scan cannot prove deletion; loaded rows or authoritative scans can (#1158).
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
