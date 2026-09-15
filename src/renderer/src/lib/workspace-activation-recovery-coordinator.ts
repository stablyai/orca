import { useAppStore } from '@/store'
import { clearWorkspaceActivationRecoveryPresentation } from './workspace-activation-recovery-presentation'
import {
  describeWorkspaceExecutionEvidence,
  resolveWorkspaceExecutionEvidence,
  type WorkspaceExecutionEvidence
} from './workspace-execution-evidence'
import type {
  WorkspaceActivationIdentity,
  WorkspaceActivationRecoveryResult
} from './worktree-activation-recovery'
import type { WorkspaceActivationRecoveryOwnerContext } from './workspace-activation-recovery-retry'
import {
  captureActivationRecoverySelectionRevision,
  hasLiveActivationTerminalTombstone,
  installActivationRecoverySelectionTracker,
  isActivationRecoveryFresh,
  markLatestActivationRecoveryAttempt,
  readActivationRenderableInventory,
  readActivationRenderableSurface,
  WORKSPACE_ACTIVATION_RECOVERY_DEADLINE_MS,
  WORKSPACE_ACTIVATION_RECOVERY_PROGRESS_DELAY_MS
} from './workspace-activation-recovery-state'
import {
  activationRecoveryFailedResult,
  activationRecoveryMaterializedResult,
  assessActivationProducerAttempts,
  clearActivationRecoveryPresentation,
  publishActivationRecovery,
  waitForActivationProducerAttempts
} from './workspace-activation-recovery-settlement'

export async function recoverWorkspaceActivationOwned(
  identity: WorkspaceActivationIdentity,
  context: WorkspaceActivationRecoveryOwnerContext
): Promise<WorkspaceActivationRecoveryResult> {
  installActivationRecoverySelectionTracker()
  markLatestActivationRecoveryAttempt(identity)
  clearWorkspaceActivationRecoveryPresentation({
    workspaceKey: identity.workspaceKey,
    executionHostId: identity.executionHostId
  })
  const capturedSelectionRevision = captureActivationRecoverySelectionRevision()
  const deadlineAt = Date.now() + WORKSPACE_ACTIVATION_RECOVERY_DEADLINE_MS
  const progressTimer = setTimeout(() => {
    try {
      if (
        isActivationRecoveryFresh(identity, capturedSelectionRevision, context) &&
        !readActivationRenderableSurface(identity)
      ) {
        publishActivationRecovery(identity, context, 'recovering')
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      publishActivationRecovery(identity, context, 'unexpected', detail)
    }
  }, WORKSPACE_ACTIVATION_RECOVERY_PROGRESS_DELAY_MS)
  try {
    if (!isActivationRecoveryFresh(identity, capturedSelectionRevision, context)) {
      return { kind: 'stale' }
    }
    const producerAssessment = assessActivationProducerAttempts(identity, context)
    const producerResult =
      producerAssessment.kind === 'wait'
        ? await waitForActivationProducerAttempts(
            identity,
            context,
            deadlineAt,
            capturedSelectionRevision
          )
        : producerAssessment.kind === 'complete'
          ? producerAssessment.result
          : null
    if (producerResult) {
      return producerResult
    }
    if (!isActivationRecoveryFresh(identity, capturedSelectionRevision, context)) {
      return { kind: 'stale' }
    }
    const { renderableTabCount, surface } = readActivationRenderableInventory(identity)
    if (!isActivationRecoveryFresh(identity, capturedSelectionRevision, context)) {
      return { kind: 'stale' }
    }
    if (surface) {
      return activationRecoveryMaterializedResult(identity, surface)
    }
    if (renderableTabCount > 0) {
      publishActivationRecovery(
        identity,
        context,
        'unexpected',
        'Workspace content exists, but no renderable surface could be selected.'
      )
      return activationRecoveryFailedResult(identity, 'unexpected')
    }
    if (context.mode === 'startup' && hasLiveActivationTerminalTombstone(identity.workspaceKey)) {
      clearActivationRecoveryPresentation(identity)
      return { kind: 'intentional-empty' }
    }
    const evidence: WorkspaceExecutionEvidence = resolveWorkspaceExecutionEvidence(
      useAppStore.getState(),
      identity.workspaceKey,
      identity.executionHostId
    )
    const detail = describeWorkspaceExecutionEvidence(evidence)
    publishActivationRecovery(
      identity,
      context,
      evidence === 'exited' ? 'unexpected' : 'unverifiable',
      detail
    )
    return evidence === 'exited'
      ? activationRecoveryFailedResult(identity, 'unexpected')
      : { kind: 'deferred', reason: detail, ownerAttemptId: null }
  } catch (error) {
    if (!isActivationRecoveryFresh(identity, capturedSelectionRevision, context)) {
      return { kind: 'stale' }
    }
    const detail = error instanceof Error ? error.message : String(error)
    publishActivationRecovery(identity, context, 'unexpected', detail)
    return activationRecoveryFailedResult(identity, 'unexpected')
  } finally {
    clearTimeout(progressTimer)
  }
}
