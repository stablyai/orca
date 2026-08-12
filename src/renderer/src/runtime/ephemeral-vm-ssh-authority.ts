import { isRuntimeOwnedSshTargetId } from '../../../shared/execution-host'
import type { SshConnectionState } from '../../../shared/ssh-types'
import { useAppStore } from '@/store'

type CompleteConnectedSshState = SshConnectionState & {
  status: 'connected'
  providerEpoch: NonNullable<SshConnectionState['providerEpoch']>
  connectionGeneration: number
}

function isCompleteConnectedSshState(
  state: SshConnectionState | null | undefined
): state is CompleteConnectedSshState {
  const connectionGeneration = state?.connectionGeneration
  return Boolean(
    state &&
    state.status === 'connected' &&
    typeof state.providerEpoch === 'string' &&
    state.providerEpoch.length > 0 &&
    typeof connectionGeneration === 'number' &&
    Number.isSafeInteger(connectionGeneration) &&
    connectionGeneration >= 0
  )
}

export function applyEphemeralVmSshState(targetId: string, state: SshConnectionState): void {
  if (!isRuntimeOwnedSshTargetId(targetId) || state.targetId !== targetId) {
    return
  }
  useAppStore.getState().setSshConnectionState(targetId, state)
}

export async function hydrateEphemeralVmSshAuthority(targetId: string): Promise<boolean> {
  if (!isRuntimeOwnedSshTargetId(targetId)) {
    return false
  }

  let state: SshConnectionState | null
  try {
    state = await window.api.ssh.getState({ targetId })
  } catch {
    return false
  }

  if (!isCompleteConnectedSshState(state)) {
    return false
  }
  if (state.targetId !== targetId) {
    return false
  }

  const current = useAppStore.getState().sshConnectionStates.get(targetId)
  if (
    isCompleteConnectedSshState(current) &&
    current.connectionGeneration > state.connectionGeneration
  ) {
    return true
  }

  applyEphemeralVmSshState(targetId, state)
  return true
}

export function clearEphemeralVmSshAuthority(targetId: string): void {
  if (!isRuntimeOwnedSshTargetId(targetId)) {
    return
  }
  useAppStore.getState().clearSshConnectionState(targetId)
}
