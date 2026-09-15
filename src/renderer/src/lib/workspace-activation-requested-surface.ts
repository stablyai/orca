import { getRuntimeEnvironmentRevision } from '@/runtime/runtime-environment-revision'
import { parseExecutionHostId } from '../../../shared/execution-host'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import { resumeSleepingAgentSessionsForWorktree } from './resume-sleeping-agent-session'
import { gateWorktreeAgentActivation } from './worktree-agent-activation-gate'
import type { WorkspaceActivationIdentity } from './worktree-activation-recovery'
import {
  captureActivationRenderableSurfaceIds,
  settleActivationSeedProducer
} from './worktree-activation-recovery-routing'
import {
  isActivationExecutionRouteCurrent,
  WORKSPACE_ACTIVATION_RECOVERY_DEADLINE_MS
} from './workspace-activation-recovery-state'
import {
  describeWorkspaceExecutionEvidence,
  type WorkspaceExecutionEvidence
} from './workspace-execution-evidence'
import {
  consumeWorkspaceSurfaceProducerAttempt,
  discardWorkspaceSurfaceProducerAttempt,
  registerWorkspaceSurfaceProducer
} from './workspace-surface-production'

type RequestedSurfaceOwner = 'local' | 'runtime-transfer' | 'backend-confirmed'

type RequestedSurfaceProduction = {
  identity: WorkspaceActivationIdentity
  executionEvidence: WorkspaceExecutionEvidence
  owner: RequestedSurfaceOwner
  createSurface: (hostAbsenceConfirmed: boolean) => string | null
}

export function produceRequestedWorkspaceSurface({
  identity,
  executionEvidence,
  owner,
  createSurface
}: RequestedSurfaceProduction): string | null {
  const producer = registerWorkspaceSurfaceProducer(identity)
  if (owner === 'runtime-transfer') {
    try {
      createSurface(false)
      producer.declined('Surface production transferred to the paired execution host.')
      consumeWorkspaceSurfaceProducerAttempt(producer.attempt.id)
    } catch (error) {
      producer.failed(error)
    }
    return null
  }
  if (owner === 'backend-confirmed') {
    try {
      const primaryTabId = createSurface(false)
      if (primaryTabId) {
        producer.materialized({ kind: 'tab', id: primaryTabId })
      } else {
        producer.unverifiable(
          'The execution host accepted the startup, but its surface is not visible yet.'
        )
      }
      return primaryTabId
    } catch (error) {
      producer.failed(error)
      return null
    }
  }
  const route = {
    ...identity,
    runtimeEnvironmentRevision: identity.runtimeEnvironmentId
      ? (getRuntimeEnvironmentRevision(identity.runtimeEnvironmentId) ?? null)
      : null
  }
  const produce = (hostAbsenceConfirmed: boolean): string | null => {
    try {
      if (!isActivationExecutionRouteCurrent(route)) {
        discardWorkspaceSurfaceProducerAttempt(producer.attempt.id)
        return null
      }
      const existingSurfaceIds = captureActivationRenderableSurfaceIds(identity.workspaceKey)
      if (!hostAbsenceConfirmed) {
        resumeSleepingAgentSessionsForWorktree(identity.workspaceKey, {
          expectedExecutionHostId: route.executionHostId,
          expectedRuntimeEnvironmentId: route.runtimeEnvironmentId,
          ...(route.runtimeEnvironmentRevision === null
            ? {}
            : { expectedRuntimeEnvironmentRevision: route.runtimeEnvironmentRevision })
        })
      }
      if (!isActivationExecutionRouteCurrent(route)) {
        discardWorkspaceSurfaceProducerAttempt(producer.attempt.id)
        return null
      }
      const primaryTabId = createSurface(hostAbsenceConfirmed)
      settleActivationSeedProducer(
        producer,
        identity.workspaceKey,
        primaryTabId,
        existingSurfaceIds
      )
      return primaryTabId
    } catch (error) {
      producer.failed(error)
      return null
    }
  }
  if (executionEvidence === 'exited') {
    return produce(false)
  }
  if (
    executionEvidence === 'unverifiable' &&
    parseExecutionHostId(identity.executionHostId)?.kind === 'ssh' &&
    parseWorkspaceKey(identity.workspaceKey)?.type === 'folder'
  ) {
    void gateWorktreeAgentActivation(route, {
      timeoutMs: WORKSPACE_ACTIVATION_RECOVERY_DEADLINE_MS
    }).then(
      (outcome) => {
        if (outcome === 'empty') {
          produce(true)
        } else if (outcome === 'stale') {
          discardWorkspaceSurfaceProducerAttempt(producer.attempt.id)
        } else if (outcome === 'blocked') {
          producer.blocked('The execution host did not provide complete ownership evidence.')
        } else {
          producer.unverifiable('The execution host owns a surface that is not visible yet.')
        }
      },
      (error: unknown) => producer.unexpected(error)
    )
  } else {
    producer.unverifiable(describeWorkspaceExecutionEvidence(executionEvidence))
  }
  return null
}
