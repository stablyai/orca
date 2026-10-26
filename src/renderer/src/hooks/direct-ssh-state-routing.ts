import type { DirectSshAuthority, SshConnectionState } from '../../../shared/ssh-types'

export type DirectSshConnectedStateOrigin = 'push' | 'initial-hydration'

export function directSshAuthorityFromConnectionState(
  targetId: string,
  state: SshConnectionState
): DirectSshAuthority | null {
  if (
    state.targetId !== targetId ||
    state.status !== 'connected' ||
    !state.providerEpoch ||
    state.connectionGeneration === undefined
  ) {
    return null
  }
  return {
    targetId,
    providerEpoch: state.providerEpoch,
    connectionGeneration: state.connectionGeneration
  }
}
