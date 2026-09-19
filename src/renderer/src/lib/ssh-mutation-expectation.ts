import {
  getSshOperationConnectionState,
  type SshOperationConnectionState
} from './ssh-operation-connection-state'
import type { SshMutationExpectation } from '../../../shared/ssh-types'
import type { AppState } from '@/store/types'
import { parseExecutionHostId, toSshExecutionHostId } from '../../../shared/execution-host'
import { resolveWorktreeOperationRoute } from './worktree-operation-route'

const SSH_OWNER_CHANGED_MESSAGE =
  "Couldn't verify the SSH connection. Reconnect the host and try again."

type DirectSshMutationState = SshOperationConnectionState

export type DirectSshMutationExpectation = {
  expectedExecutionHostId: `ssh:${string}`
  expectedSshTargetId: string
  expectedSshConnectionGeneration: number
}

/**
 * Capture the target and connection generation required to authorize an SSH mutation.
 * Throw if the owning runtime has no verifiable connection generation.
 */
export function captureDirectSshMutationExpectation(
  state: DirectSshMutationState,
  connectionId: string,
  runtimeEnvironmentId?: string | null
): DirectSshMutationExpectation {
  const generation = getSshOperationConnectionState(
    state,
    connectionId,
    runtimeEnvironmentId
  )?.connectionGeneration
  if (generation === undefined) {
    throw new Error(SSH_OWNER_CHANGED_MESSAGE)
  }
  return {
    expectedExecutionHostId: toSshExecutionHostId(connectionId),
    expectedSshTargetId: connectionId,
    expectedSshConnectionGeneration: generation
  }
}

/**
 * Resolve a workspace route and capture its SSH mutation authority when applicable.
 * Local and runtime-host routes use local execution within their owning process; unknown owners fail closed.
 */
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
  const generation = getSshOperationConnectionState(
    state,
    host.targetId,
    route?.runtimeEnvironmentId
  )?.connectionGeneration
  if (generation === undefined) {
    throw new Error(SSH_OWNER_CHANGED_MESSAGE)
  }
  return {
    expectedExecutionHostId: host.id,
    expectedSshTargetId: host.targetId,
    expectedSshConnectionGeneration: generation
  }
}
