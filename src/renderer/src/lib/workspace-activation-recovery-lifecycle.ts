import type { ExecutionHostId } from '../../../shared/execution-host'
import { clearWorkspaceActivationRecoveryPresentations } from './workspace-activation-recovery-presentation'
import { clearLatestActivationRecoveryAttempts } from './workspace-activation-recovery-attempts'
import { clearActivationRecoveryFailureSnapshots } from './workspace-activation-recovery-failure-snapshots'
import { clearWorkspaceSurfaceProducerAttempts } from './workspace-surface-production'

export function clearWorkspaceActivationRecoveryLifecycle(args: {
  workspaceKey?: string
  executionHostId?: ExecutionHostId
}): void {
  const removedAttemptIds = clearWorkspaceSurfaceProducerAttempts(args)
  clearActivationRecoveryFailureSnapshots(removedAttemptIds)
  clearWorkspaceActivationRecoveryPresentations(args)
  clearLatestActivationRecoveryAttempts(args)
}
