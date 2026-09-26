import { getExecutionHostIdForWorktree } from './worktree-runtime-owner'
import type { WorktreeRuntimeOwnerState } from './worktree-runtime-owner'
import type { ExecutionHostId } from '../../../shared/execution-host'
import {
  runtimeTargetForExecutionHostId,
  type RuntimeClientTarget
} from '@/runtime/runtime-client-target'
import { LOCAL_STRUCTURED_SESSION_OWNER } from '@/runtime/local-structured-session-owner'
import { getRuntimeEnvironmentRevision } from '@/runtime/runtime-environment-revision'

export function structuredAgentLaunchTarget(
  state: WorktreeRuntimeOwnerState,
  worktreeId: string
): RuntimeClientTarget {
  return structuredAgentLaunchTargetForExecutionHostId(
    getExecutionHostIdForWorktree(state, worktreeId)
  )
}

export function structuredAgentLaunchTargetForExecutionHostId(
  hostId: ExecutionHostId
): RuntimeClientTarget {
  const target = runtimeTargetForExecutionHostId(hostId)
  if (!target) {
    throw new Error('Structured chat requires a local or paired Orca runtime.')
  }
  return target.kind === 'environment'
    ? {
        ...target,
        expectedEnvironmentPairingRevision: getRuntimeEnvironmentRevision(target.environmentId)
      }
    : target
}

export function structuredAgentLaunchFocusOwner(target: RuntimeClientTarget) {
  return target.kind === 'local'
    ? { environmentId: LOCAL_STRUCTURED_SESSION_OWNER }
    : {
        environmentId: target.environmentId,
        pairingRevision:
          target.expectedEnvironmentPairingRevision ??
          getRuntimeEnvironmentRevision(target.environmentId)
      }
}
