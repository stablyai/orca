import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type { WorktreeCreationRequest } from '@/lib/pending-worktree-creation'
import { completeWorktreeCreation } from '@/lib/worktree-creation-completion'
import { buildWorktreeCreationStartupOpt } from '@/lib/worktree-creation-flow-startup'
import { launchStructuredWorktreeSession } from '@/lib/worktree-creation-structured-session'
import {
  structuredWorkItemLaunchUnavailableMessage,
  structuredWorkItemPromptDeliveryFailedMessage
} from '@/lib/launch-work-item-direct-messages'

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
    structuredLaunchRecoveryWorktreeId: worktreeId,
    structuredLaunchRetryDisabled: false
  })
}

export function markStructuredWorktreeLaunchFailed(
  creationId: string,
  worktreeId: string,
  failure: 'launch-refused' | 'prompt-delivery'
): void {
  const error =
    failure === 'launch-refused'
      ? structuredWorkItemLaunchUnavailableMessage()
      : structuredWorkItemPromptDeliveryFailedMessage()
  useAppStore.getState().updatePendingWorktreeCreation(creationId, {
    status: 'error',
    error,
    structuredLaunchRecoveryWorktreeId: worktreeId,
    structuredLaunchRetryDisabled: true
  })
}

export function markStructuredWorktreePromptDeliveryUnconfirmed(
  creationId: string,
  worktreeId: string
): void {
  useAppStore.getState().updatePendingWorktreeCreation(creationId, {
    status: 'error',
    error: translate(
      'auto.lib.worktree.creation.flow.structured.prompt.unknown',
      'Could not confirm whether the work item prompt was delivered. Retry to reconcile the same message.'
    ),
    structuredLaunchRecoveryWorktreeId: worktreeId,
    structuredLaunchRetryDisabled: false
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
  if (structuredSession.promptDeliveryUnknown) {
    markStructuredWorktreePromptDeliveryUnconfirmed(creationId, worktreeId)
    return
  }
  if (structuredSession.failure) {
    markStructuredWorktreeLaunchFailed(creationId, worktreeId, structuredSession.failure)
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
