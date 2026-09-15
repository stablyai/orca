import { createBrowserUuid } from './browser-uuid'
import { startWorkspaceActivationSurfaceProducer } from './workspace-activation-surface-producer'
import type {
  WorkspaceActivationContext,
  WorkspaceActivationIdentity,
  WorkspaceActivationRecoveryResult
} from './worktree-activation-recovery'

export type WorkspaceActivationRecoveryOwnerContext = WorkspaceActivationContext & {
  retry: () => void
}

type RecoverWorkspaceActivation = (
  identity: WorkspaceActivationIdentity,
  context: WorkspaceActivationContext
) => Promise<WorkspaceActivationRecoveryResult>

export function createWorkspaceActivationRecoveryOwnerContext(
  identity: WorkspaceActivationIdentity,
  context: WorkspaceActivationContext,
  recoverWorkspaceActivation: RecoverWorkspaceActivation
): WorkspaceActivationRecoveryOwnerContext {
  return {
    ...context,
    retry: () => {
      const retryIdentity = { ...identity, attemptId: createBrowserUuid() }
      // Retry is a user action: it runs a concrete producer under explicit-activation authority and
      // abandons the settled verdict that stranded it, whatever kind or producer that verdict came from.
      startWorkspaceActivationSurfaceProducer(retryIdentity, {
        mode: 'explicit',
        supersedeSettledOwnership: true
      })
      void recoverWorkspaceActivation(retryIdentity, { mode: context.mode })
    }
  }
}
