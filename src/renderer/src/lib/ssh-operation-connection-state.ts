import type { AppState } from '@/store/types'
import type { SshConnectionState } from '../../../shared/ssh-types'
import { isRuntimeOwnedSshTargetId } from '../../../shared/execution-host'

export type SshOperationConnectionState = Pick<
  AppState,
  'sshConnectionStates' | 'runtimeOwnedSshConnectionStates' | 'sshStateByEnvironment'
>

/** Resolve authority in its owning runtime; never borrow a same-id desktop session. */
export function getSshOperationConnectionState(
  state: SshOperationConnectionState,
  targetId: string,
  runtimeEnvironmentId?: string | null
): SshConnectionState | undefined {
  if (runtimeEnvironmentId) {
    return state.sshStateByEnvironment.get(runtimeEnvironmentId)?.connectionStates.get(targetId)
  }
  if (isRuntimeOwnedSshTargetId(targetId)) {
    const connection = state.runtimeOwnedSshConnectionStates.get(targetId)
    return connection?.status === 'connected' ? connection : undefined
  }
  return state.sshConnectionStates.get(targetId)
}
