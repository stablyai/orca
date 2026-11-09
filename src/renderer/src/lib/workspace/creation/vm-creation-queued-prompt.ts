// A first prompt typed while a VM (Orca Cloud) workspace is still being built, like a message sent
// to a local create's pending chat: the agent starts with it once the workspace is ready.
import { useAppStore } from '@/store'
import type {
  PendingWorktreeCreation,
  WorktreeCreationRequest
} from '@/lib/workspace/creation/pending-worktree-creation'

type QueueInput = Pick<PendingWorktreeCreation, 'phase' | 'status' | 'request'>

/** The prompt still editable: the VM is provisioning and the create will start an agent. */
export function canQueueVmCreationPrompt(entry: QueueInput | undefined): boolean {
  if (!entry || entry.status !== 'creating' || entry.phase !== 'provisioning-vm') {
    return false
  }
  const { request } = entry
  return (
    Boolean(request.ephemeralVmRecipe) &&
    request.agent !== null &&
    (request.agentLaunchRoute === 'structured-native-chat' || request.creationStartup !== undefined)
  )
}

/** A composer prompt meant only as an unsent draft is typed in, not sent; a queued one is sent. */
export function vmCreationPromptIsDraft(
  entry: Pick<PendingWorktreeCreation, 'heldChatMessage' | 'request'>
): boolean {
  return (
    entry.heldChatMessage === undefined &&
    (Boolean(entry.request.launchDraftPrompt) || entry.request.promptDelivery === 'draft')
  )
}

/** What the agent will be sent first: the queued prompt, else the composer's. */
export function vmCreationFirstPrompt(
  entry: Pick<PendingWorktreeCreation, 'heldChatMessage' | 'request'>
): string {
  return entry.heldChatMessage ?? entry.request.launchDraftPrompt ?? entry.request.quickPrompt
}

export function queueVmCreationPrompt(creationId: string, text: string): void {
  const state = useAppStore.getState()
  if (!canQueueVmCreationPrompt(state.pendingWorktreeCreations[creationId])) {
    return
  }
  state.updatePendingWorktreeCreation(creationId, { heldChatMessage: text })
}

/** Folds a queued prompt into the prepared request, so the agent launch sends it on its own. */
export function takeQueuedVmCreationPrompt(
  creationId: string,
  request: WorktreeCreationRequest
): WorktreeCreationRequest {
  const store = useAppStore.getState()
  const held = store.pendingWorktreeCreations[creationId]?.heldChatMessage
  if (held === undefined || !request.ephemeralVmRecipe || !request.agent) {
    return request
  }
  const { launchDraftPrompt: _replaced, ...rest } = request
  const next: WorktreeCreationRequest = {
    ...rest,
    quickPrompt: held,
    promptDelivery: 'auto-submit'
  }
  if (request.creationStartup) {
    const rebuilt = request.creationStartup.legacy(held, 'auto-submit')
    next.startupPlan = rebuilt.startupPlan
    next.startup = rebuilt.backendStartup
  }
  // The request now carries it; a held message left behind would be delivered a second time.
  store.updatePendingWorktreeCreation(creationId, { heldChatMessage: undefined, request: next })
  return next
}
