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

/**
 * The first send's staged browser files stay leased until a holder is proven: the send was recorded as
 * delivered, or the chat the draft moved into still references every submitted file. A moved draft alone
 * proves nothing: a refused send can come back with an unavailable chip and no reference, and releasing
 * then would leave no readable copy. Undelivered files stay for Retry or the recipient; dismissing the
 * pending creation, or deleting the draft that now holds them, releases them.
 */
export function releaseFirstSendFilesWhenHeld(
  delivery: Promise<StructuredPromptDeliveryResult> | undefined,
  draftTransferred: () => boolean,
  files: { release: () => void; heldByDraft: () => boolean }
): void {
  void delivery?.then((result) => {
    if (result.delivered || (draftTransferred() && files.heldByDraft())) {
      files.release()
    }
  })
}
