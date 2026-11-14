import type { AppState } from '@/store/types'
import {
  projectGroupHookOwner,
  projectGroupHookTrustKey
} from '../../../../shared/workspace-hook-owner'
import {
  getRepoExecutionHostId,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'

export function findHookRepo(state: AppState, repoId: string, hostId?: ExecutionHostId) {
  const group = state.projectGroups.find(
    (entry) =>
      projectGroupHookTrustKey(entry) === repoId &&
      (!hostId || getRepoExecutionHostId(entry) === hostId)
  )
  if (group) {
    return projectGroupHookOwner(group) ?? undefined
  }
  return hostId
    ? state.repos.find((repo) => repo.id === repoId && getRepoExecutionHostId(repo) === hostId)
    : state.repos.find((repo) => repo.id === repoId)
}

/** Inspect on the captured runtime owner, then explicit host, then repo owner; never substitute focused host, including server-owned SSH repos. */
export function hookRepoOwnerHostId(
  state: AppState,
  repoId: string,
  hostId?: ExecutionHostId,
  runtimeOwnerEnvironmentId?: string | null
): ExecutionHostId {
  const ownerEnvironmentId = runtimeOwnerEnvironmentId?.trim()
  if (ownerEnvironmentId) {
    return toRuntimeExecutionHostId(ownerEnvironmentId)
  }
  const rows = hostId ? [] : state.repos.filter((entry) => entry.id === repoId)
  // Why: with the id on two hosts, trusting one row's script could run the other's unseen.
  if (rows.length > 1) {
    throw new Error('The project exists on more than one host.')
  }
  const repo = rows[0] ?? null
  const ownerHostId = hostId ?? (repo ? getRepoExecutionHostId(repo) : null)
  if (!ownerHostId) {
    throw new Error('The project host is unknown.')
  }
  return ownerHostId
}
