import {
  getRepoExecutionHostId,
  getSettingsFocusedExecutionHostId,
  parseExecutionHostId
} from '../../../shared/execution-host'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { Repo } from '../../../shared/repo-types'
import { ipcOrRuntimeTargetForHostId } from '@/runtime/runtime-client-target'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'

export type RepoRuntimeOwnerState = {
  repos?: readonly Pick<Repo, 'id' | 'connectionId' | 'executionHostId'>[]
  settings?: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null
}

function findRepoOwner(
  state: RepoRuntimeOwnerState,
  repoId: string
): Pick<Repo, 'id' | 'connectionId' | 'executionHostId'> | null {
  const matchingRepos = state.repos?.filter((entry) => entry.id === repoId) ?? []
  if (matchingRepos.length === 0) {
    return null
  }
  if (matchingRepos.length === 1) {
    return matchingRepos[0]
  }
  const focusedHostId = getSettingsFocusedExecutionHostId(state.settings)
  const focusedMatches = matchingRepos.filter(
    (entry) => getRepoExecutionHostId(entry) === focusedHostId
  )
  // Why: duplicate bare repo ids are only safe to route when focus selects one
  // owner unambiguously; otherwise callers must avoid guessing a host.
  return focusedMatches.length === 1 ? focusedMatches[0] : null
}

/**
 * Transport to a repo row's owner; a row with no owner stamp is local. `null` when no row, or no
 * single row among duplicates, names the repo.
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
  const hasExplicitOwner = Boolean(repo?.executionHostId?.trim() || repo?.connectionId?.trim())
  if (repo && hasExplicitOwner) {
    const parsed = parseExecutionHostId(getRepoExecutionHostId(repo))
    return parsed?.kind === 'runtime' ? parsed.environmentId : null
  }
  return state.settings?.activeRuntimeEnvironmentId?.trim() || null
}

// Why: PR mutations must not fall back to the globally focused runtime — a
// repo without an explicit owner is a local repo, and routing it to the
// focused runtime sends the mutation to a host that does not own it (#6957).
export function getExplicitRuntimeOwnerEnvironmentId(
  state: RepoRuntimeOwnerState,
  repoId: string | null | undefined
): string | null {
  if (!repoId) {
    return null
  }
  const repo = findRepoOwner(state, repoId)
  const hasExplicitOwner = Boolean(repo?.executionHostId?.trim() || repo?.connectionId?.trim())
  if (!repo || !hasExplicitOwner) {
    return null
  }
  const parsed = parseExecutionHostId(getRepoExecutionHostId(repo))
  return parsed?.kind === 'runtime' ? parsed.environmentId : null
}

// Why: a source without a runtime host inherits a repo's runtime owner only when exactly one
// row has that id; duplicate ids across hosts fail closed to the source's own host (#7623).
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
