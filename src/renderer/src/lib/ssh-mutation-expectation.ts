import type { SshMutationExpectation } from '../../../shared/ssh-types'
import type { AppState } from '@/store/types'
import { parseExecutionHostId, toSshExecutionHostId } from '../../../shared/execution-host'
import { resolveWorktreeOperationRoute } from './worktree-operation-route'

const SSH_OWNER_CHANGED_MESSAGE =
  "Couldn't verify the SSH connection. Reconnect the host and try again."

type DirectSshMutationState = Pick<AppState, 'sshConnectionStates'> &
  Partial<Pick<AppState, 'sshStateByEnvironment'>>

export type DirectSshMutationExpectation = {
  expectedExecutionHostId: `ssh:${string}`
  expectedSshTargetId: string
  expectedSshConnectionGeneration: number
}

export function captureDirectSshMutationExpectation(
  state: DirectSshMutationState,
  connectionId: string,
  runtimeEnvironmentId?: string | null
): DirectSshMutationExpectation {
  const generation = runtimeEnvironmentId
    ? state.sshStateByEnvironment?.get(runtimeEnvironmentId)?.connectionStates.get(connectionId)
        ?.connectionGeneration
    : state.sshConnectionStates.get(connectionId)?.connectionGeneration
  if (generation === undefined) {
    throw new Error(SSH_OWNER_CHANGED_MESSAGE)
  }
  return {
    expectedExecutionHostId: toSshExecutionHostId(connectionId),
    expectedSshTargetId: connectionId,
    expectedSshConnectionGeneration: generation
  }
}

export function captureWorktreeSshMutationExpectation(
  state: AppState,
  worktreeId: string
): SshMutationExpectation & { expectedExecutionHostId: 'local' | `ssh:${string}` } {
  const route = resolveWorktreeOperationRoute(state, worktreeId)
  const host = parseExecutionHostId(route?.executionHostId)
  if (host?.kind === 'local' || host?.kind === 'runtime') {
    return { expectedExecutionHostId: 'local' }
  }
  if (host?.kind !== 'ssh') {
    throw new Error(SSH_OWNER_CHANGED_MESSAGE)
  }
  const generation = route?.runtimeEnvironmentId
    ? state.sshStateByEnvironment
        .get(route.runtimeEnvironmentId)
        ?.connectionStates.get(host.targetId)?.connectionGeneration
    : state.sshConnectionStates.get(host.targetId)?.connectionGeneration
  if (generation === undefined) {
    throw new Error(SSH_OWNER_CHANGED_MESSAGE)
  }
  return {
    expectedExecutionHostId: host.id,
    expectedSshTargetId: host.targetId,
    expectedSshConnectionGeneration: generation
  }
}
