import { useAppStore } from '@/store'
import { resolveWorkspaceExecutionEvidence } from './workspace-execution-evidence'
import {
  canInspectAgentActivationInventory,
  hasLiveActivationTerminalTombstone,
  isActivationExecutionRouteCurrent,
  readActivationRenderableSurface,
  WORKSPACE_ACTIVATION_RECOVERY_DEADLINE_MS
} from './workspace-activation-recovery-state'
import {
  discardWorkspaceSurfaceProducerAttempt,
  readWorkspaceSurfaceProducerEntries,
  registerWorkspaceSurfaceProducer,
  type WorkspaceSurfaceProducer
} from './workspace-surface-production'
import { ensureWorktreeHasInitialTerminal } from './worktree-initial-terminal-seeding'
import { gateWorktreeAgentActivation } from './worktree-agent-activation-gate'
import { workspaceHasSleepingAgentSessions } from './worktree-agent-activation-claims'
import type { WorktreeAgentActivationRoute } from './worktree-agent-activation-route'
import type { WorkspaceActivationIdentity } from './worktree-activation-recovery'
import { getRuntimeEnvironmentRevision } from '@/runtime/runtime-environment-revision'
import { clearActivationRecoveryFailureSnapshots } from './workspace-activation-recovery-failure-snapshots'

type ActivationSurfaceProductionContext = {
  mode: 'explicit' | 'startup'
  /** Retry only: abandon every settled attempt so a stranded verdict cannot gate the user. */
  supersedeSettledOwnership?: boolean
}

function settleProducedSurface(
  producer: WorkspaceSurfaceProducer,
  identity: WorkspaceActivationIdentity & WorktreeAgentActivationRoute,
  context: ActivationSurfaceProductionContext,
  maySeedEmptySurface: boolean,
  hostAbsenceConfirmed = false
): string | null {
  if (!isActivationExecutionRouteCurrent(identity)) {
    discardWorkspaceSurfaceProducerAttempt(producer.attempt.id)
    return null
  }
  const visible = readActivationRenderableSurface(identity)
  if (!isActivationExecutionRouteCurrent(identity)) {
    discardWorkspaceSurfaceProducerAttempt(producer.attempt.id)
    return null
  }
  if (visible) {
    producer.materialized({ kind: 'tab', id: visible.id })
    return visible.id
  }
  const state = useAppStore.getState()
  const evidence = resolveWorkspaceExecutionEvidence(
    state,
    identity.workspaceKey,
    identity.executionHostId,
    hostAbsenceConfirmed
  )
  if (evidence !== 'exited') {
    producer.unverifiable('Orca cannot verify the execution host for this workspace surface.')
    return null
  }
  if (!maySeedEmptySurface) {
    producer.unverifiable(
      'The activation gate found execution ownership, but its surface is not visible yet.'
    )
    return null
  }
  const primaryTabId = ensureWorktreeHasInitialTerminal(
    state,
    identity.workspaceKey,
    undefined,
    undefined,
    undefined,
    undefined,
    { reseedEmptiedWorkspace: context.mode === 'explicit', hostAbsenceConfirmed }
  )
  const materialized = primaryTabId ? readActivationRenderableSurface(identity) : null
  if (materialized) {
    producer.materialized({ kind: 'tab', id: materialized.id })
    return materialized.id
  }
  if (context.mode === 'startup' && hasLiveActivationTerminalTombstone(identity.workspaceKey)) {
    producer.intentionalEmpty()
    return null
  }
  producer.unverifiable('The activation producer did not publish a renderable surface.')
  return null
}

// An automatic activation only reclaims its own settled attempts: a concrete producer's verdict is
// still the truthful report of that launch, and re-gating it can only replace it with a weaker one.
// A settled `unverifiable` is the exception — it is a claim about the host, not about that launch, so
// once route evidence says otherwise the claim is stale and must not latch the workspace shut.
// Retry is the explicit abandon path, so it supersedes every settled attempt.
function clearSettledActivationOwnership(
  identity: WorkspaceActivationIdentity,
  supersedeAll: boolean
): void {
  const entries = readWorkspaceSurfaceProducerEntries(identity)
  const evidence = entries.some((entry) => entry.result?.kind === 'unverifiable')
    ? resolveWorkspaceExecutionEvidence(
        useAppStore.getState(),
        identity.workspaceKey,
        identity.executionHostId
      )
    : 'unverifiable'
  const supersededAttemptIds: string[] = []
  for (const entry of entries) {
    if (entry.result === null) {
      continue
    }
    const staleHostClaim = entry.result.kind === 'unverifiable' && evidence !== 'unverifiable'
    if (supersedeAll || entry.attempt.purpose === 'activation-recovery' || staleHostClaim) {
      discardWorkspaceSurfaceProducerAttempt(entry.attempt.id)
      supersededAttemptIds.push(entry.attempt.id)
    }
  }
  clearActivationRecoveryFailureSnapshots(supersededAttemptIds)
}

export function startWorkspaceActivationSurfaceProducer(
  identity: WorkspaceActivationIdentity,
  context: ActivationSurfaceProductionContext
): string | null {
  const route: WorkspaceActivationIdentity & WorktreeAgentActivationRoute = {
    ...identity,
    runtimeEnvironmentRevision: identity.runtimeEnvironmentId
      ? (getRuntimeEnvironmentRevision(identity.runtimeEnvironmentId) ?? null)
      : null
  }
  if (!isActivationExecutionRouteCurrent(route)) {
    return null
  }
  clearSettledActivationOwnership(identity, context.supersedeSettledOwnership === true)
  let visible: ReturnType<typeof readActivationRenderableSurface>
  try {
    visible = readActivationRenderableSurface(identity)
  } catch (error) {
    const producer = registerWorkspaceSurfaceProducer({
      workspaceKey: identity.workspaceKey,
      executionHostId: identity.executionHostId,
      purpose: 'activation-recovery'
    })
    producer.unexpected(error)
    return null
  }
  const hasSleepingSessions = workspaceHasSleepingAgentSessions(
    useAppStore.getState(),
    identity.workspaceKey
  )
  if (visible && !hasSleepingSessions) {
    return visible.id
  }
  if (readWorkspaceSurfaceProducerEntries(identity).length > 0) {
    return null
  }
  const producer = registerWorkspaceSurfaceProducer({
    workspaceKey: identity.workspaceKey,
    executionHostId: identity.executionHostId,
    purpose: 'activation-recovery'
  })
  if (!canInspectAgentActivationInventory(identity.runtimeEnvironmentId) && !hasSleepingSessions) {
    try {
      return settleProducedSurface(producer, route, context, true)
    } catch (error) {
      producer.unexpected(error)
      return null
    }
  }
  void gateWorktreeAgentActivation(route, {
    timeoutMs: WORKSPACE_ACTIVATION_RECOVERY_DEADLINE_MS
  }).then(
    (outcome) => {
      if (outcome === 'stale') {
        discardWorkspaceSurfaceProducerAttempt(producer.attempt.id)
        return
      }
      if (outcome === 'blocked') {
        producer.blocked(
          'Orca paused activation because the execution host did not provide complete ownership evidence.'
        )
        return
      }
      try {
        settleProducedSurface(producer, route, context, outcome === 'empty', outcome === 'empty')
      } catch (error) {
        producer.unexpected(error)
      }
    },
    (error: unknown) => producer.unexpected(error)
  )
  return null
}
