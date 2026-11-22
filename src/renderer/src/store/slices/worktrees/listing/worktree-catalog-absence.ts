import type { AppState } from '../../../types'
import type { ExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import { splitWorktreeId, worktreeIdsEqual } from '../../../../../../shared/worktree/id'
import { parseWorkspaceKey } from '../../../../../../shared/workspace/identity/workspace-scope'
import { structuralValuesEqualIgnoringUndefined } from '../../../../../../shared/collections/structural-value-equality'
import { isCurrentDetectedWorktreeRefresh } from './detected-worktree-refresh-admission'
import { worktreeCatalogVersionKey } from './worktree-catalog-version-state'
import {
  repoHasExactlyOneExecutionHostOwner,
  worktreeHostMatchOptions,
  worktreeMatchesHost
} from './worktree-host-ownership'
import type {
  AdmittedDetectedWorktreeRefresh,
  WorktreeCatalogAuthority
} from './worktree-slice-types'

type CatalogAuthorityState = Pick<
  AppState,
  'runtimeEnvironments' | 'worktreeCatalogAuthorityByRepoHost'
>

function runtimePairingRevision(state: CatalogAuthorityState, environmentId?: string) {
  const runtime = state.runtimeEnvironments.find((environment) => environment.id === environmentId)
  return runtime?.pairingRevision ?? runtime?.createdAt
}

export function appliedWorktreeCatalogAuthorityPatch(
  state: CatalogAuthorityState,
  repoId: string,
  refresh: AdmittedDetectedWorktreeRefresh
): Pick<AppState, 'worktreeCatalogAuthorityByRepoHost'> | null {
  const { executionHostId, runtimeAuthority, directSshAuthority, result } = refresh
  const catalogs = state.worktreeCatalogAuthorityByRepoHost
  const key = worktreeCatalogVersionKey(repoId, executionHostId)
  const authority: WorktreeCatalogAuthority | undefined =
    result.authoritative && result.source === 'git'
      ? {
          executionHostId,
          runtimeAuthority,
          directSshAuthority,
          pairingRevision:
            runtimeAuthority && runtimePairingRevision(state, runtimeAuthority.environmentId)
        }
      : undefined
  return structuralValuesEqualIgnoringUndefined(catalogs[key], authority)
    ? null
    : { worktreeCatalogAuthorityByRepoHost: { ...catalogs, [key]: authority } }
}

export function worktreeCatalogConfirmsAbsence(
  state: CatalogAuthorityState &
    Pick<AppState, 'repos' | 'sshConnectionStates' | 'worktreesByRepo' | 'detectedWorktreesByRepo'>,
  workspaceId: string,
  hostId: ExecutionHostId
): boolean {
  const scope = parseWorkspaceKey(workspaceId)
  if (scope?.type === 'folder') {
    return false
  }
  const worktreeId = scope?.worktreeId ?? workspaceId
  const parsed = splitWorktreeId(worktreeId)
  if (!parsed) {
    return false
  }
  const { repoId } = parsed
  const authority =
    state.worktreeCatalogAuthorityByRepoHost[worktreeCatalogVersionKey(repoId, hostId)]
  const detected = state.detectedWorktreesByRepo[repoId]
  if (
    !authority ||
    !detected ||
    !isCurrentDetectedWorktreeRefresh(state, authority) ||
    !repoHasExactlyOneExecutionHostOwner(state, repoId, hostId, false)
  ) {
    return false
  }
  if (
    authority.runtimeAuthority &&
    authority.pairingRevision !==
      runtimePairingRevision(state, authority.runtimeAuthority.environmentId)
  ) {
    return false
  }
  const options = worktreeHostMatchOptions(state, repoId, hostId)
  return ![detected.worktrees, state.worktreesByRepo[repoId] ?? []].some((rows) =>
    rows.some(
      (worktree) =>
        worktreeIdsEqual(worktree.id, worktreeId) && worktreeMatchesHost(worktree, hostId, options)
    )
  )
}
