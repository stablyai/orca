import type { Repo } from '../../../../shared/repo-types'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session-state-types'
import type { DetectedWorktreeListResult, Worktree } from '../../../../shared/worktree/types'
import {
  getRawWorktreeIdFromWorkspaceSessionKey,
  parseWorkspaceKey
} from '../../../../shared/workspace-scope'
import { getRepoIdFromWorktreeId, splitWorktreeId } from '../../../../shared/worktree/id'

function hasWorktreePath(value: string): boolean {
  const parsed = splitWorktreeId(value)
  return Boolean(parsed?.repoId && parsed.worktreePath)
}

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
  const add = (value: unknown): void => {
    if (typeof value === 'string' && value.length > 0) {
      persistedWorktreeIds.add(value)
    }
  }
  // A scoped selection can be the only evidence for a workspace (for example,
  // a canonical SSH key with no open tabs at quit time). Keep legacy raw
  // activeWorktreeId validation unchanged so stale pointers still clear.
  const activeWorkspaceScope = parseWorkspaceKey(session.activeWorkspaceKey ?? '')
  add(session.activeWorkspaceKey)
  if (parseWorkspaceKey(session.activeWorktreeId ?? '')) {
    add(session.activeWorktreeId)
  } else if (
    activeWorkspaceScope?.type === 'worktree' &&
    session.activeWorktreeId === activeWorkspaceScope.worktreeId
  ) {
    // Keep the raw alias paired with a canonical active key for callers that
    // still index the catalog by its legacy spelling.
    add(session.activeWorktreeId)
  }
  for (const worktreeId of session.activeWorktreeIdsOnShutdown ?? []) {
    add(worktreeId)
  }
  for (const worktreeId of Object.keys(session.tabsByWorktree)) {
    add(worktreeId)
  }
  for (const worktreeId of Object.keys(session.unifiedTabs ?? {})) {
    add(worktreeId)
  }
  for (const worktreeId of Object.keys(session.openFilesByWorktree ?? {})) {
    add(worktreeId)
  }
  for (const worktreeId of Object.keys(session.browserTabsByWorktree ?? {})) {
    add(worktreeId)
  }
  for (const pages of Object.values(session.browserPagesByWorkspace ?? {})) {
    if (!Array.isArray(pages)) {
      continue
    }
    for (const page of pages) {
      add(page.worktreeId)
    }
  }
  for (const record of Object.values(session.sleepingAgentSessionsByPaneKey ?? {})) {
    add(record.worktreeId)
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

  for (const worktreeId of persistedWorktreeIds) {
    const rawWorktreeId = getRawWorktreeIdFromWorkspaceSessionKey(worktreeId)
    if (rawWorktreeId === null) {
      continue
    }
    if (validWorktreeIds.has(worktreeId)) {
      continue
    }
    if (parseWorkspaceKey(worktreeId)?.type === 'worktree' && !hasWorktreePath(rawWorktreeId)) {
      continue
    }
    const repoId = getRepoIdFromWorktreeId(rawWorktreeId)
    const rawWorktreeIsValid = validWorktreeIds.has(rawWorktreeId)
    // Why (#1158): a failed scan cannot prove deletion, while loaded worktrees or an authoritative scan can.
    if (
      rawWorktreeIsValid ||
      (knownRepoIds.has(repoId) &&
        !repoIdsWithLoadedWorktrees.has(repoId) &&
        !repoIdsWithAuthoritativeDetectedWorktrees.has(repoId))
    ) {
      validWorktreeIds.add(worktreeId)
      // Keep the raw alias too when a canonical key is the only persisted spelling. This lets
      // metadata/reconnect lookups continue using the catalog's durable id.
      if (worktreeId !== rawWorktreeId) {
        validWorktreeIds.add(rawWorktreeId)
      }
    }
  }

  return validWorktreeIds
}
