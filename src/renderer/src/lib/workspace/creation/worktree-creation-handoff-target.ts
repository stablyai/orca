import { requestBackgroundTerminalWorktreeMount } from '@/components/terminal/workspace-mounting/background-terminal-worktree-mount'
import {
  nativeChatComposerSelection,
  waitForNativeChatComposerHandoff
} from '@/components/native-chat/composer/focus/native-chat-composer-mount'
import '@/components/native-chat/composer/focus/use-native-chat-composer-reveal-focus'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store/index'
import { getStructuredAgentSessionLaunchOwner } from '@/lib/agent-session/launch/structured-agent-session-launch-registry'
import { moveStructuredAgentLaunchDraft } from '@/lib/agent-session/launch/structured-agent-session-launch-draft'
import { captureNativeChatComposerFocusIntent } from '@/components/native-chat/composer/focus/native-chat-composer-focus-intent'
import type { ExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import type { StructuredPromptDeliveryResult } from '@/lib/agent-session/launch/structured-agent-session-launch-callers'

/** The chat that should receive a new worktree's pending draft: its tab, session and host. */
export type WorktreeCreationHandoffTarget = {
  tabId: string
  sessionId: string
  executionHostId: ExecutionHostId | undefined
}

/** Read the target from the live store; null once the tab is gone or is not an agent chat of the worktree. */
export function readWorktreeCreationHandoffTarget(
  tabId: string | null,
  worktreeId: string
): WorktreeCreationHandoffTarget | null {
  const tab = tabId ? useAppStore.getState().getTab(tabId) : null
  if (tab?.contentType !== 'agent-session' || tab.worktreeId !== worktreeId) {
    return null
  }
  return {
    tabId: tab.id,
    sessionId: tab.entityId,
    executionHostId: tab.executionHostId ?? getStructuredAgentSessionLaunchOwner(tab.entityId)
  }
}

/**
 * A target captured before an await only says where the draft was meant to go. Re-read it right before
 * moving: the move is allowed only into the same session on the same host, never a stale snapshot.
 */
export function confirmWorktreeCreationHandoffTarget(
  captured: WorktreeCreationHandoffTarget,
  worktreeId: string
): (WorktreeCreationHandoffTarget & { executionHostId: ExecutionHostId }) | null {
  const current = readWorktreeCreationHandoffTarget(captured.tabId, worktreeId)
  if (
    !current?.executionHostId ||
    current.sessionId !== captured.sessionId ||
    (captured.executionHostId !== undefined && current.executionHostId !== captured.executionHostId)
  ) {
    return null
  }
  return { ...current, executionHostId: current.executionHostId }
}

/** Move the source draft into the confirmed target; false (input stays at its source) if it went stale. */
export function moveWorktreeCreationDraftToTarget(
  captured: WorktreeCreationHandoffTarget,
  worktreeId: string,
  sourceScope: string,
  selection: { from: number; to: number } | undefined
): boolean {
  const target = confirmWorktreeCreationHandoffTarget(captured, worktreeId)
  if (!target) {
    return false
  }
  if (selection) {
    captureNativeChatComposerFocusIntent().request(target.tabId)
  }
  moveStructuredAgentLaunchDraft(
    { sessionId: target.sessionId, worktreeId, executionHostId: target.executionHostId },
    sourceScope,
    selection
  )
  return true
}

/** Terminal attempts release their lease; the pending row owns a separate Retry hold after loss. */
export function releaseFirstSendFilesWhenHeld(
  delivery: Promise<StructuredPromptDeliveryResult> | undefined,
  sourceScope: string,
  files: { release: () => void; retainForRetry: (scope: string) => void; releaseRetry?: () => void }
): Promise<StructuredPromptDeliveryResult | undefined> {
  return Promise.resolve(delivery).then((result) => {
    if (result && !result.delivered && !result.handBackFinished) {
      files.retainForRetry(sourceScope)
    }
    files.release()
    if (result?.delivered) {
      files.releaseRetry?.()
    }
    void result?.whenRecorded?.then(() => files.releaseRetry?.())
    return result
  })
}

export async function waitForWorktreeCreationFirstSend(
  delivery: Promise<StructuredPromptDeliveryResult>,
  sourceScope: string,
  files: Parameters<typeof releaseFirstSendFilesWhenHeld>[2],
  signal: AbortSignal
): Promise<StructuredPromptDeliveryResult | undefined | null> {
  const interrupted = Promise.withResolvers<null>()
  const interrupt = (): void => interrupted.resolve(null)
  if (signal.aborted) {
    interrupt()
  } else {
    signal.addEventListener('abort', interrupt, { once: true })
  }
  const settled = releaseFirstSendFilesWhenHeld(delivery, sourceScope, {
    ...files,
    retainForRetry: (scope) => {
      if (!signal.aborted) {
        files.retainForRetry(scope)
      }
    }
  })
  return Promise.race([settled, interrupted.promise]).finally(() =>
    signal.removeEventListener('abort', interrupt)
  )
}

export function retainWorktreeCreationInput(
  creationId: string,
  worktreeId: string,
  chatOpened = false
): void {
  useAppStore.getState().updatePendingWorktreeCreation(creationId, {
    worktreeId,
    status: 'error',
    error: chatOpened
      ? translate(
          'components.native-chat.writeNotice.outcomeUnknown',
          "Orca couldn't confirm what happened. Check the chat."
        )
      : translate(
          'components.native-chat.creationChatNotOpened',
          'Your worktree is ready, but the chat could not open. Retry to open it with your message.'
        )
  })
}

export function recordWorktreeCreationFirstSend(
  result: StructuredPromptDeliveryResult,
  creationId: string,
  handedOffAt: number | undefined
): void {
  void result.whenRecorded?.then(() => {
    const current = useAppStore.getState().pendingWorktreeCreations[creationId]
    if (current && current.chatHandedOffAt === handedOffAt) {
      useAppStore
        .getState()
        .updatePendingWorktreeCreation(creationId, { heldChatMessageRecorded: true })
    }
  })
}

export async function handOffWorktreeCreationDraft(args: {
  tabId: string | null
  worktreeId: string
  sourceScope: string
  creationId: string
  shouldActivate: boolean
  signal: AbortSignal
  revealSignal: AbortSignal
}): Promise<boolean> {
  const tab = readWorktreeCreationHandoffTarget(args.tabId, args.worktreeId)
  if (!tab) {
    return false
  }
  const state = useAppStore.getState()
  if (
    args.shouldActivate &&
    state.activeView === 'terminal' &&
    state.activePendingCreationId === args.creationId
  ) {
    requestBackgroundTerminalWorktreeMount({ worktreeId: args.worktreeId, tabIds: [tab.tabId] })
    await waitForNativeChatComposerHandoff(args.sourceScope, tab.tabId, args.revealSignal, 5000)
  }
  if (args.signal.aborted) {
    return false
  }
  const selection = args.revealSignal.aborted
    ? undefined
    : nativeChatComposerSelection(args.sourceScope)
  return moveWorktreeCreationDraftToTarget(tab, args.worktreeId, args.sourceScope, selection)
}
