import { toast } from 'sonner'
import { useAppStore } from '@/store'
import {
  findPendingLinkedWorkItemCreationId,
  pendingCreationChatDraftScopeKey,
  type WorktreeCreationPhase,
  type WorktreeCreationRequest
} from '@/lib/pending-worktree-creation'
import { updateNativeChatComposerDraft } from '@/components/native-chat/native-chat-composer-draft-store'
import { promptTextContent } from '@/components/native-chat/native-chat-prompt-document-text'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { executeWorktreeCreation } from '@/lib/worktree-creation-flow-execute'
import {
  getInitialWorktreeCreationPhase,
  getWorktreeCreationIndeterminate
} from '@/lib/worktree-creation-flow-startup'
import {
  formatWorkspaceCreateError,
  getWorkspaceCreateErrorToastMessage
} from '@/lib/workspace-create-error-format'

type ContinueBackgroundWorktreeCreationOptions = {
  revealCreationSurface?: boolean
}

// Contain fire-and-forget rejections or pending creation UI remains stuck without errors.
function startWorktreeCreation(creationId: string, request: WorktreeCreationRequest): void {
  executeWorktreeCreation(creationId, request).catch((error: unknown) => {
    console.error('worktree create: unhandled failure', creationId, error)
    const store = useAppStore.getState()
    if (!store.pendingWorktreeCreations[creationId]) {
      return
    }
    const message = getWorkspaceCreateErrorToastMessage(formatWorkspaceCreateError(error))
    store.updatePendingWorktreeCreation(creationId, { status: 'error', error: message })
    // Inline creation errors need a separate toast only after navigation away.
    if (!(store.activeView === 'terminal' && store.activePendingCreationId === creationId)) {
      toast.error(message)
    }
  })
}

// The chat composer shows before the worktree exists, so a linked item's draft starts there.
function seedPendingChatDraft(
  creationId: string,
  request: WorktreeCreationRequest,
  prior?: WorktreeCreationRequest
): void {
  const draft = request.launchDraftPrompt
  if (
    !draft ||
    draft === prior?.launchDraftPrompt ||
    request.promptDelivery !== 'draft' ||
    request.agentLaunchRoute !== 'structured-native-chat'
  ) {
    return
  }
  updateNativeChatComposerDraft(
    pendingCreationChatDraftScopeKey(creationId),
    { text: draft, document: promptTextContent(draft) },
    'immediate'
  )
}

function revealPendingCreation(
  creationId: string,
  request: WorktreeCreationRequest,
  phase: WorktreeCreationPhase
): void {
  const store = useAppStore.getState()
  const indeterminate = getWorktreeCreationIndeterminate(request)
  store.beginPendingWorktreeCreation({
    creationId,
    phase,
    status: 'creating',
    startedAt: Date.now(),
    indeterminate,
    // Give creation its tab strip synchronously; delayed reveal flashes the prior workspace’s tabs.
    loaderVisible: true,
    request
  })
  seedPendingChatDraft(creationId, request)
  // Creation UI renders only in terminal view; activate it before publishing the panel.
  store.setActiveView('terminal')
  store.setSidebarOpen(true)
}

/** Start creation without blocking the composer; the pending panel owns preparation and errors. */
export function runBackgroundWorktreeCreation(request: WorktreeCreationRequest): string {
  const store = useAppStore.getState()
  const existingCreationId = findPendingLinkedWorkItemCreationId(
    store.pendingWorktreeCreations,
    request
  )
  if (existingCreationId) {
    store.setActivePendingWorktreeCreation(existingCreationId)
    store.setActiveView('terminal')
    store.setSidebarOpen(true)
    return existingCreationId
  }
  // Plain-HTTP LAN clients lack randomUUID; createBrowserUuid uses getRandomValues fallback.
  const creationId = createBrowserUuid()
  revealPendingCreation(creationId, request, getInitialWorktreeCreationPhase(request))
  startWorktreeCreation(creationId, request)
  return creationId
}

/** Stage a pending entry before async preflight so the UI shows immediate progress. */
export function beginBackgroundWorktreePreparation(request: WorktreeCreationRequest): string {
  const creationId = createBrowserUuid()
  revealPendingCreation(creationId, request, 'preparing')
  return creationId
}

/** Continue a staged pending entry once async preflight has produced a final request. */
export function continueBackgroundWorktreeCreation(
  creationId: string,
  request: WorktreeCreationRequest,
  options: ContinueBackgroundWorktreeCreationOptions = {}
): boolean {
  const store = useAppStore.getState()
  const staged = store.pendingWorktreeCreations[creationId]
  if (!staged) {
    return false
  }
  seedPendingChatDraft(creationId, request, staged.request)
  // Remote creates emit no phases; use captured submit-owner progress mode so Retry cannot change with focused runtime.
  store.updatePendingWorktreeCreation(creationId, {
    phase: getInitialWorktreeCreationPhase(request),
    status: 'creating',
    startedAt: Date.now(),
    error: undefined,
    provisioningLog: undefined,
    checkoutProgress: undefined,
    request
  })
  // Late background preflight preserves pending rows without reselecting creation after navigation.
  if (options.revealCreationSurface !== false) {
    store.setActivePendingWorktreeCreation(creationId)
    store.setActiveView('terminal')
    store.setSidebarOpen(true)
  }
  startWorktreeCreation(creationId, request)
  return true
}

/** Re-run a failed creation from its panel, reusing the captured request. */
export function retryBackgroundWorktreeCreation(creationId: string): void {
  const store = useAppStore.getState()
  const entry = store.pendingWorktreeCreations[creationId]
  if (!entry) {
    return
  }
  store.updatePendingWorktreeCreation(creationId, {
    status: 'creating',
    startedAt: Date.now(),
    phase: getInitialWorktreeCreationPhase(entry.request),
    error: undefined,
    provisioningLog: undefined,
    checkoutProgress: undefined,
    worktreeId: undefined
  })
  store.setActivePendingWorktreeCreation(creationId)
  store.setActiveView('terminal')
  store.setSidebarOpen(true)
  startWorktreeCreation(creationId, entry.request)
}
