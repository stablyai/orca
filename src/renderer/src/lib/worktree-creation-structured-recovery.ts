import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type { WorktreeCreationRequest } from '@/lib/pending-worktree-creation'
import { completeWorktreeCreation } from '@/lib/worktree-creation-completion'
import { buildWorktreeCreationStartupOpt } from '@/lib/worktree-creation-flow-startup'
import { launchStructuredWorktreeSession } from '@/lib/worktree-creation-structured-session'

export function markStructuredWorktreeLaunchUnconfirmed(
  creationId: string,
  worktreeId: string
): void {
  useAppStore.getState().updatePendingWorktreeCreation(creationId, {
    status: 'error',
    error: translate(
      'auto.lib.worktree.creation.flow.structured.launch.unknown',
      'Could not confirm whether Codex chat opened. Retry to check again.'
    ),
    structuredLaunchRecoveryWorktreeId: worktreeId
  })
}

export async function retryStructuredWorktreeLaunch(
  creationId: string,
  request: WorktreeCreationRequest,
  worktreeId: string
): Promise<void> {
  if (!useAppStore.getState().pendingWorktreeCreations[creationId]) {
    return
  }
  const structuredSession = await launchStructuredWorktreeSession({
    creationId,
    request,
    worktreeId,
    shouldActivateOnCompletion: true,
    fallbackStartupOpt: buildWorktreeCreationStartupOpt(request, false),
    activation: false,
    primaryTabId: null,
    recoverUnknownLaunch: true
  })
  if (structuredSession.cancelled) {
    return
  }
  if (structuredSession.visibilityUnknown) {
    markStructuredWorktreeLaunchUnconfirmed(creationId, worktreeId)
    return
  }
  await completeWorktreeCreation({
    creationId,
    request,
    worktreeId,
    structuredLaunchAccepted: structuredSession.accepted,
    activation: structuredSession.activation,
    primaryTabId: structuredSession.primaryTabId,
    backendSpawned: false,
    focusOnCompletion: true
  })
}
