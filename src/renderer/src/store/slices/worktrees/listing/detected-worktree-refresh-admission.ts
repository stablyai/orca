import { getEnvironmentSshStateGeneration } from '../../runtime-environment-ssh'
import { getRuntimeEnvironmentConnectionGeneration } from '../../runtime-status'
import type { AppState } from '../../../types'
import type { HostQualifiedDetectedWorktreeResult } from '../../../../../../shared/detected-worktree-provider-contract'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import type { AdmittedDetectedWorktreeRefresh } from './worktree-slice-types'
import { directSshAuthoritiesEqual, getCurrentDirectSshAuthority } from './direct-ssh-authority'
import { isStaleWorktreeCatalogPublication } from './worktree-catalog-version-state'
import { repoHasExactlyOneExecutionHostOwner } from './worktree-host-ownership'

/**
 * Why a listing was not applied. `not-current`: the connection or repo owner it was listed under
 * no longer holds. `superseded`: a newer catalog (a create or remove reply) is already applied.
 */
export type WorktreeListingRefusal = 'not-current' | 'superseded'
export type WorktreeListingMergeOutcome = 'applied' | WorktreeListingRefusal

export function isCurrentDetectedWorktreeRefresh(
  state: Pick<AppState, 'sshConnectionStates'>,
  refresh: AdmittedDetectedWorktreeRefresh
): boolean {
  if (refresh.directSshAuthority) {
    return directSshAuthoritiesEqual(
      getCurrentDirectSshAuthority(state, refresh.executionHostId),
      refresh.directSshAuthority
    )
  }
  if (refresh.runtimeAuthority) {
    return (
      getEnvironmentSshStateGeneration(refresh.runtimeAuthority.environmentId) ===
        refresh.runtimeAuthority.connectionGeneration &&
      getRuntimeEnvironmentConnectionGeneration(refresh.runtimeAuthority.environmentId) ===
        refresh.runtimeAuthority.runtimeConnectionGeneration
    )
  }
  return true
}

/** Decided inside the store update, so callers report the reason the merge actually acted on. */
export function worktreeListingRefusal(
  state: Pick<AppState, 'sshConnectionStates' | 'repos' | 'worktreeCatalogVersionByRepoHost'>,
  refresh: AdmittedDetectedWorktreeRefresh,
  repoId: string,
  hostId: ExecutionHostId,
  ownerMayBeMissing: boolean
): WorktreeListingRefusal | null {
  if (
    !isCurrentDetectedWorktreeRefresh(state, refresh) ||
    !repoHasExactlyOneExecutionHostOwner(state, repoId, hostId, ownerMayBeMissing)
  ) {
    return 'not-current'
  }
  if (isStaleWorktreeCatalogPublication(state, repoId, hostId, refresh.result.catalogVersion)) {
    return 'superseded'
  }
  return null
}

export function staleDetectedWorktreeProviderResult(
  refresh: AdmittedDetectedWorktreeRefresh
): HostQualifiedDetectedWorktreeResult | undefined {
  return refresh.providerResult
    ? {
        providerRequestId: refresh.providerResult.providerRequestId,
        executionHostId: refresh.executionHostId,
        status: 'stale'
      }
    : undefined
}
