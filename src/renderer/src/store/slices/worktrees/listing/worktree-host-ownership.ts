import type { AppState } from '../../../types'
import type { ProjectHostSetup } from '../../../../../../shared/project-types'
import type { DetectedWorktreeListResult, Worktree } from '../../../../../../shared/worktree/types'
import { findRepoForHost } from '../../repo-host-identity'
import { reuseEqualCatalogRows } from '../../worktree-catalog-reconciliation'
import { getRepoIdFromWorktreeId } from '../../worktree-helpers'
import {
  getRepoExecutionHostId,
  getSettingsFocusedExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../../../../../shared/execution-host'
import { toVisibleWorktree } from './worktree-catalog-visibility'
import type { WorktreeHostMatchOptions, RepoHostSummary } from './worktree-slice-types'

export function withRepoHostOwnership<
  T extends {
    hostId?: ExecutionHostId
    runtimeOwnerEnvironmentId?: string
    projectId?: string
    projectHostSetupId?: string
  }
>(worktree: T, hostId: ExecutionHostId, setup?: ProjectHostSetup): T {
  const parsedOwner = parseExecutionHostId(hostId)
  const runtimeOwnerEnvironmentId =
    parsedOwner?.kind === 'runtime' ? parsedOwner.environmentId : undefined
  const worktreeHost = parseExecutionHostId(worktree.hostId)
  // Why: an SSH worktree reached through a paired HUB has two owners; retain the SSH execution host and stamp the HUB transport separately.
  const nextHostId =
    hostId === LOCAL_EXECUTION_HOST_ID ||
    (runtimeOwnerEnvironmentId !== undefined && worktreeHost?.kind === 'ssh')
      ? worktree.hostId
      : hostId
  const projectId = worktree.projectId ?? setup?.projectId
  const projectHostSetupId = worktree.projectHostSetupId ?? setup?.id
  if (
    nextHostId === worktree.hostId &&
    runtimeOwnerEnvironmentId === worktree.runtimeOwnerEnvironmentId &&
    projectId === worktree.projectId &&
    projectHostSetupId === worktree.projectHostSetupId
  ) {
    return worktree
  }
  return {
    ...worktree,
    ...(nextHostId ? { hostId: nextHostId } : {}),
    runtimeOwnerEnvironmentId,
    ...(projectId ? { projectId } : {}),
    ...(projectHostSetupId ? { projectHostSetupId } : {})
  } as T
}

export function repoHostId(
  state: Pick<AppState, 'repos' | 'settings'>,
  repoId: string,
  hostId?: ExecutionHostId | null
): ExecutionHostId {
  const repo = findRepoForHost(state.repos, repoId, { hostId, settings: state.settings })
  if (repo) {
    return getRepoExecutionHostId(repo)
  }
  return hostId && parseExecutionHostId(hostId)
    ? hostId
    : getSettingsFocusedExecutionHostId(state.settings)
}

export function repoHasExactlyOneExecutionHostOwner(
  state: Pick<AppState, 'repos'>,
  repoId: string,
  hostId: ExecutionHostId,
  ownerWasMissingAtStart: boolean
): boolean {
  const repoOwners = state.repos.filter((repo) => repo.id === repoId)
  if (repoOwners.length === 0) {
    return ownerWasMissingAtStart
  }
  const ownerHostIds = repoOwners.map((repo) => {
    const hasExplicitHost = repo.executionHostId !== null && repo.executionHostId !== undefined
    const explicitHost = hasExplicitHost ? parseExecutionHostId(repo.executionHostId) : null
    if (hasExplicitHost && !explicitHost) {
      return null
    }
    const rawConnectionId = repo.connectionId
    const hasConnection = rawConnectionId !== null && rawConnectionId !== undefined
    const connectionId = hasConnection ? rawConnectionId.trim() : null
    if (hasConnection && !connectionId) {
      return null
    }
    if (!connectionId || explicitHost?.kind === 'runtime') {
      return explicitHost?.id ?? LOCAL_EXECUTION_HOST_ID
    }
    if (explicitHost && explicitHost.id !== toSshExecutionHostId(connectionId)) {
      return null
    }
    return explicitHost?.id ?? toSshExecutionHostId(connectionId)
  })
  return (
    ownerHostIds.every((ownerHostId) => ownerHostId !== null) &&
    ownerHostIds.filter((ownerHostId) => ownerHostId === hostId).length === 1
  )
}

export function toVisibleWorktrees(
  result: DetectedWorktreeListResult,
  hostId: ExecutionHostId,
  setup?: ProjectHostSetup
): Worktree[] {
  return result.worktrees
    .filter((worktree) => worktree.visible)
    .map(toVisibleWorktree)
    .map((worktree) => withRepoHostOwnership(worktree, hostId, setup))
}

export function getProjectHostSetupForRepoHost(
  state: Partial<Pick<AppState, 'projectHostSetups'>>,
  repoId: string,
  hostId: ExecutionHostId
): ProjectHostSetup | undefined {
  return state.projectHostSetups?.find(
    (setup) => setup.repoId === repoId && setup.hostId === hostId
  )
}

export function getHydratedSessionWorktreeIdsForRepo(state: AppState, repoId: string): string[] {
  return Object.keys(state.tabsByWorktree).filter((id) => getRepoIdFromWorktreeId(id) === repoId)
}

export const repoHostSummariesByRepos = new WeakMap<
  AppState['repos'],
  Map<string, RepoHostSummary>
>()

export function getRepoHostSummaries(repos: AppState['repos']): Map<string, RepoHostSummary> {
  const cached = repoHostSummariesByRepos.get(repos)
  if (cached) {
    return cached
  }

  const summaries = new Map<string, RepoHostSummary>()
  for (const repo of repos) {
    const current = summaries.get(repo.id)
    if (current) {
      summaries.set(repo.id, { count: current.count + 1 })
    } else {
      summaries.set(repo.id, { count: 1, onlyHostId: getRepoExecutionHostId(repo) })
    }
  }
  repoHostSummariesByRepos.set(repos, summaries)
  return summaries
}

export function unhostedWorktreesMatchRefreshHost(
  state: Pick<AppState, 'repos'>,
  repoId: string,
  hostId: ExecutionHostId
): boolean {
  if (hostId === LOCAL_EXECUTION_HOST_ID) {
    return true
  }

  const summary = getRepoHostSummaries(state.repos).get(repoId)
  return summary?.count === 1 && summary.onlyHostId === hostId
}

export function worktreeHostMatchOptions(
  state: Pick<AppState, 'repos'>,
  repoId: string,
  hostId: ExecutionHostId
): WorktreeHostMatchOptions {
  return {
    // Why: pre-host persisted runtime/SSH worktrees lack hostId; treat them as the sole repo owner's rows but keep ambiguous duplicates local.
    unhostedWorktreesMatchHost: unhostedWorktreesMatchRefreshHost(state, repoId, hostId)
  }
}

export function worktreeMatchesHost(
  worktree: { hostId?: ExecutionHostId; runtimeOwnerEnvironmentId?: string },
  hostId: ExecutionHostId,
  options: WorktreeHostMatchOptions = {}
): boolean {
  const parsedRefreshHost = parseExecutionHostId(hostId)
  if (parsedRefreshHost?.kind === 'runtime') {
    if (worktree.runtimeOwnerEnvironmentId) {
      return worktree.runtimeOwnerEnvironmentId === parsedRefreshHost.environmentId
    }
    if (worktree.hostId) {
      return worktree.hostId === hostId
    }
    return options.unhostedWorktreesMatchHost ?? false
  }
  if (worktree.runtimeOwnerEnvironmentId) {
    return false
  }
  if (worktree.hostId) {
    return worktree.hostId === hostId
  }
  return options.unhostedWorktreesMatchHost ?? hostId === LOCAL_EXECUTION_HOST_ID
}

export function mergeWorktreesForHost<
  T extends { id: string; hostId?: ExecutionHostId; runtimeOwnerEnvironmentId?: string }
>(
  current: readonly T[] | undefined,
  refreshed: readonly T[],
  hostId: ExecutionHostId,
  options?: WorktreeHostMatchOptions
): T[] {
  // Why: host-scoped refreshes replace that host in place so alternating local/runtime refreshes don't churn sibling row order or sortEpoch.
  const existing = current ?? []
  const reconciled = reuseEqualCatalogRows(
    existing.filter((worktree) => worktreeMatchesHost(worktree, hostId, options)),
    refreshed
  )
  const next: T[] = []
  let inserted = false

  for (const worktree of existing) {
    if (worktreeMatchesHost(worktree, hostId, options)) {
      if (!inserted) {
        next.push(...reconciled)
        inserted = true
      }
      continue
    }
    next.push(worktree)
  }

  if (!inserted) {
    next.push(...reconciled)
  }
  return existing.length === next.length && existing.every((row, index) => row === next[index])
    ? (existing as T[])
    : next
}

export function getKnownWorktreeIdsForPurge(
  state: AppState,
  repoId: string,
  hostId: ExecutionHostId
): string[] {
  const detected = state.detectedWorktreesByRepo[repoId]
  const knownIds = new Set<string>()
  const matchOptions = worktreeHostMatchOptions(state, repoId, hostId)
  if (detected?.authoritative === true) {
    for (const worktree of detected.worktrees) {
      if (worktreeMatchesHost(worktree, hostId, matchOptions)) {
        knownIds.add(worktree.id)
      }
    }
  } else {
    for (const worktree of state.worktreesByRepo[repoId] ?? []) {
      if (worktreeMatchesHost(worktree, hostId, matchOptions)) {
        knownIds.add(worktree.id)
      }
    }
  }
  if (!state.hasHydratedWorktreePurge && matchOptions.unhostedWorktreesMatchHost === true) {
    // Why (#1158): hydration can preserve tab keys before worktree metadata exists; the first authoritative scan must still reap deleted session-only keys.
    for (const id of getHydratedSessionWorktreeIdsForRepo(state, repoId)) {
      knownIds.add(id)
    }
  }
  return [...knownIds]
}

export function getRemovedWorktreeIdsAfterAuthoritativeScan(
  state: AppState,
  repoId: string,
  detected: DetectedWorktreeListResult,
  hostId: ExecutionHostId
): string[] {
  if (!detected.authoritative) {
    return []
  }
  const detectedIds = new Set(detected.worktrees.map((worktree) => worktree.id))
  return getKnownWorktreeIdsForPurge(state, repoId, hostId).filter((id) => !detectedIds.has(id))
}

export function toLegacyDetectedWorktreeResult(
  repoId: string,
  result: { worktrees: Worktree[] }
): DetectedWorktreeListResult {
  return {
    repoId,
    authoritative: true,
    source: 'session-fallback',
    worktrees: result.worktrees.map((worktree) => ({
      ...worktree,
      ownership: 'orca-managed',
      selectedCheckout: false,
      visible: true
    }))
  }
}
