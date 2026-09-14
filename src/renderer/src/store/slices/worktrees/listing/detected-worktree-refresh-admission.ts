import { getEnvironmentSshStateGeneration } from '../../runtime-environment-ssh'
import { getRuntimeEnvironmentConnectionGeneration } from '../../runtime-status'
import type { AppState } from '../../../types'
import type { HostQualifiedDetectedWorktreeResult } from '../../../../../../shared/detected-worktree-provider-contract'
import type { AdmittedDetectedWorktreeRefresh } from './worktree-slice-types'
import { directSshAuthoritiesEqual, getCurrentDirectSshAuthority } from './direct-ssh-authority'

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
