import {
  getRepoExecutionHostId,
  getSettingsFocusedExecutionHostId,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { Repo } from '../../../shared/repo-types'
import { ipcOrRuntimeTargetForHostId } from '@/runtime/runtime-client-target'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'

export type RepoRuntimeOwnerState = {
  repos?: readonly Pick<Repo, 'id' | 'connectionId' | 'executionHostId'>[]
  settings?: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null
}

/** The only row with this id; a twin names no owner, as `resolveOwner` reads it, so callers refuse. */
function findRepoOwner(
  state: RepoRuntimeOwnerState,
  repoId: string
): Pick<Repo, 'id' | 'connectionId' | 'executionHostId'> | null {
  const matchingRepos = state.repos?.filter((entry) => entry.id === repoId) ?? []
  return matchingRepos.length === 1 ? matchingRepos[0] : null
}

/** Resolve twins through caller host, else Active Server focus; this nonrefusable route must not fall to local IPC and this machine’s credentials. */
function findTwinRepoOwner(
  state: RepoRuntimeOwnerState,
  repoId: string,
  hostId: ExecutionHostId | null | undefined
): Pick<Repo, 'id' | 'connectionId' | 'executionHostId'> | null {
  const matchingRepos = state.repos?.filter((entry) => entry.id === repoId) ?? []
  if (matchingRepos.length < 2) {
    return matchingRepos[0] ?? null
  }
  const pickHostId = hostId ?? getSettingsFocusedExecutionHostId(state.settings)
  const hostMatches = matchingRepos.filter((entry) => getRepoExecutionHostId(entry) === pickHostId)
  return hostMatches.length === 1 ? hostMatches[0] : null
}

/** Whether two rows (hosts) publish this repo id, so no host-less caller may pick one. */
export function isTwinRepo(state: RepoRuntimeOwnerState, repoId: string | null | undefined) {
  return (state.repos?.filter((entry) => entry.id === repoId).length ?? 0) > 1
}

/**
 * Transport to a repo row's owner; a row with no owner stamp is local. `null` when no row, or no
 * single row among duplicates, names the repo — {@link isTwinRepo} tells the two apart.
 */
export function runtimeTargetForRepoOwner(
  state: RepoRuntimeOwnerState,
  repoId: string | null | undefined
): RuntimeClientTarget | null {
  const repo = repoId ? findRepoOwner(state, repoId) : null
  return repo ? ipcOrRuntimeTargetForHostId(getRepoExecutionHostId(repo)) : null
}

export function getRuntimeEnvironmentIdForRepo(
  state: RepoRuntimeOwnerState,
  repoId: string | null | undefined
): string | null {
  if (!repoId) {
    return null
  }
  const repo = findRepoOwner(state, repoId)
  if (repo) {
    // Why: an unstamped row is local; the client stamps every server row on arrival.
    const parsed = parseExecutionHostId(getRepoExecutionHostId(repo))
    return parsed?.kind === 'runtime' ? parsed.environmentId : null
  }
  // Why: only a repo with no row yet follows focus; a twin names no server rather than a guessed one.
  return isTwinRepo(state, repoId)
    ? null
    : state.settings?.activeRuntimeEnvironmentId?.trim() || null
}

// Unstamped repos are local; focus would send mutations to a nonowner (#6957). Only twins without caller-host evidence use focus.
export function getExplicitRuntimeOwnerEnvironmentId(
  state: RepoRuntimeOwnerState,
  repoId: string | null | undefined,
  hostId?: ExecutionHostId | null
): string | null {
  if (!repoId) {
    return null
  }
  const repo = findTwinRepoOwner(state, repoId, hostId)
  const hasExplicitOwner = Boolean(repo?.executionHostId?.trim() || repo?.connectionId?.trim())
  if (!repo || !hasExplicitOwner) {
    return null
  }
  const parsed = parseExecutionHostId(getRepoExecutionHostId(repo))
  return parsed?.kind === 'runtime' ? parsed.environmentId : null
}

// Inherit repo runtime only for a unique ID; cross-host duplicates fail closed to the source’s own host (#7623).
export function getHostlessSourceRepoOwnerEnvironmentId(
  repos: RepoRuntimeOwnerState['repos'],
  repoId: string | null | undefined
): string | null {
  const matches = repoId ? (repos?.filter((entry) => entry.id === repoId) ?? []) : []
  if (matches.length !== 1) {
    return null
  }
  const parsed = parseExecutionHostId(getRepoExecutionHostId(matches[0]))
  return parsed?.kind === 'runtime' ? parsed.environmentId : null
}
