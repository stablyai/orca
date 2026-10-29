import type { SshMutationExpectation } from '../../../shared/ssh-types'
import type { AppState } from '@/store/types'
import { parseExecutionHostId, toSshExecutionHostId } from '../../../shared/execution-host'
import { resolveOwner } from './resolve-owner'

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

/** The host a write to this workspace expects, from its strict owner; a twin or unplaced id refuses. */
export function captureWorktreeSshMutationExpectation(
  state: AppState,
  worktreeId: string
): SshMutationExpectation & { expectedExecutionHostId: 'local' | `ssh:${string}` } {
  const match = resolveOwner(state, { workspaceId: worktreeId })
  if (match.kind !== 'resolved') {
    throw new Error(SSH_OWNER_CHANGED_MESSAGE)
  }
  const { endpoint, at } = match.owner
  const host = parseExecutionHostId(at)
  if (host?.kind !== 'ssh') {
    return { expectedExecutionHostId: 'local' }
  }
  return captureDirectSshMutationExpectation(
    state,
    host.targetId,
    endpoint.kind === 'environment' ? endpoint.environmentId : null
  )
}
