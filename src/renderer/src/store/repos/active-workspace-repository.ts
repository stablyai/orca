import type { Repo } from '../../../../shared/repo-types'
import type { AppState } from '../types'
import { getRepoExecutionHostId, parseExecutionHostId } from '../../../../shared/execution-host'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { getIndexedRepoMap as getCachedRepoMap } from './repository-catalog-index'

export type ActiveWorkspaceRepoState = Pick<
  AppState,
  'repos' | 'activeRepoId' | 'activeWorkspaceExecutionHostId'
>

// Cache host-filtered repo branch by repos/active host; unrelated writes must not rescan every repo.
const activeWorkspaceRepoCache = new WeakMap<AppState['repos'], Map<string, Repo | null>>()

function resolveRepoOnActiveWorkspaceHost(
  state: ActiveWorkspaceRepoState,
  repoId: string,
  activeWorkspaceExecutionHostId: ExecutionHostId
): Repo | null {
  const repoCandidates = state.repos.filter((candidate) => candidate.id === repoId)
  const hostMatch = repoCandidates.find(
    (candidate) => getRepoExecutionHostId(candidate) === activeWorkspaceExecutionHostId
  )
  if (hostMatch) {
    return hostMatch
  }
  // Paired-hub repo/SSH-worktree mismatch is valid via withRepoHostOwnership; reject other mismatches.
  if (parseExecutionHostId(activeWorkspaceExecutionHostId)?.kind !== 'ssh') {
    return null
  }
  const pairedHubRepos = repoCandidates.filter(
    (candidate) => parseExecutionHostId(getRepoExecutionHostId(candidate))?.kind === 'runtime'
  )
  return pairedHubRepos.length === 1 ? pairedHubRepos[0] : null
}

export function selectRepoByIdForActiveWorkspace(
  state: ActiveWorkspaceRepoState,
  repoId: string | null
): Repo | null {
  if (!repoId) {
    return null
  }
  const repo = getCachedRepoMap(state.repos).get(repoId) ?? null
  const activeWorkspaceExecutionHostId = state.activeWorkspaceExecutionHostId
  if (repoId !== state.activeRepoId || !activeWorkspaceExecutionHostId) {
    return repo
  }
  // The branch below only fires for the active repo, so the host id fully keys it.
  let byHost = activeWorkspaceRepoCache.get(state.repos)
  if (!byHost) {
    byHost = new Map()
    activeWorkspaceRepoCache.set(state.repos, byHost)
  }
  const cacheKey = `${activeWorkspaceExecutionHostId}\u0000${repoId}`
  const cached = byHost.get(cacheKey)
  if (cached !== undefined) {
    return cached
  }
  const resolved = resolveRepoOnActiveWorkspaceHost(state, repoId, activeWorkspaceExecutionHostId)
  byHost.set(cacheKey, resolved)
  return resolved
}
