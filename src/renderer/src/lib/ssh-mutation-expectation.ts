import type { SshMutationExpectation } from '../../../shared/ssh-types'
import type { AppState } from '@/store/types'
import {
  isRuntimeOwnedSshTargetId,
  parseExecutionHostId,
  toSshExecutionHostId
} from '../../../shared/execution-host'
import {
  resolveWorktreeOperationRoute,
  type WorktreeOperationRoute
} from './worktree-operation-route'

const SSH_OWNER_CHANGED_MESSAGE =
  "Couldn't verify the SSH connection. Reconnect the host and try again."

// Partial on everything but sshConnectionStates: callers range from full AppState to hand-built literals.
export type SshConnectionGenerationLookupState = Pick<AppState, 'sshConnectionStates'> &
  Partial<Pick<AppState, 'sshStateByEnvironment' | 'runtimeOwnedSshConnectionGenerations'>>

export function getExpectedSshConnectionGenerationForTarget(
  state: SshConnectionGenerationLookupState,
  targetId: string,
  runtimeEnvironmentId: string | null | undefined
): number | undefined {
  if (runtimeEnvironmentId) {
    return state.sshStateByEnvironment?.get(runtimeEnvironmentId)?.connectionStates.get(targetId)
      ?.connectionGeneration
  }
  const published = state.sshConnectionStates.get(targetId)?.connectionGeneration
  if (published !== undefined || !isRuntimeOwnedSshTargetId(targetId)) {
    return published
  }
  // Why: runtime-owned (ephemeral-VM) targets are suppressed from ssh:state-changed, so their
  // authority arrives on a dedicated channel. Only ever consult it for a locally-owned route (#11762).
  return state.runtimeOwnedSshConnectionGenerations?.get(targetId)
}

export function getExpectedSshConnectionGeneration(
  state: SshConnectionGenerationLookupState,
  route: WorktreeOperationRoute
): number | undefined {
  const host = parseExecutionHostId(route.executionHostId)
  if (host?.kind !== 'ssh') {
    return undefined
  }
  return getExpectedSshConnectionGenerationForTarget(
    state,
    host.targetId,
    route.runtimeEnvironmentId
  )
}

export type DirectSshMutationExpectation = {
  expectedExecutionHostId: `ssh:${string}`
  expectedSshTargetId: string
  expectedSshConnectionGeneration: number
}

export function captureDirectSshMutationExpectation(
  state: SshConnectionGenerationLookupState,
  connectionId: string,
  runtimeEnvironmentId?: string | null
): DirectSshMutationExpectation {
  const generation = getExpectedSshConnectionGenerationForTarget(
    state,
    connectionId,
    runtimeEnvironmentId
  )
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
  const generation = getExpectedSshConnectionGenerationForTarget(
    state,
    host.targetId,
    route?.runtimeEnvironmentId
  )
  if (generation === undefined) {
    throw new Error(SSH_OWNER_CHANGED_MESSAGE)
  }
  return {
    expectedExecutionHostId: host.id,
    expectedSshTargetId: host.targetId,
    expectedSshConnectionGeneration: generation
  }
}
