import { useAppStore } from '@/store/index'
import { pendingCreationChatDraftScopeKey } from './pending-worktree-creation'
import { moveStructuredAgentLaunchDraft } from '@/lib/agent-session/launch/structured-agent-session-launch-draft'
import { preparePendingChatDraftHandoff } from '@/components/native-chat/drafts/native-chat-composer-draft-move'
import { getStructuredAgentSessionLaunchOwner } from '@/lib/agent-session/launch/structured-agent-session-launch-registry'
import { requestBackgroundTerminalWorktreeMount } from '@/components/terminal/workspace-mounting/background-terminal-worktree-mount'
import {
  nativeChatComposerSelection,
  waitForNativeChatComposerHandoff
} from '@/components/native-chat/composer/focus/native-chat-composer-mount'
import '@/components/native-chat/composer/focus/use-native-chat-composer-reveal-focus'
import { captureNativeChatComposerFocusIntent } from '@/components/native-chat/composer/focus/native-chat-composer-focus-intent'

const HANDOFF_READY_TIMEOUT_MS = 5000

export async function handOffPendingWorktreeChatDraft(
  args: { creationId: string; worktreeId: string; shouldActivateOnCompletion: boolean },
  tabId: string | null,
  abandoned: AbortSignal,
  revealAbandoned: AbortSignal
): Promise<void> {
  const sourceScope = pendingCreationChatDraftScopeKey(args.creationId)
  const tab = tabId ? useAppStore.getState().getTab(tabId) : null
  if (tab?.contentType !== 'agent-session' || tab.worktreeId !== args.worktreeId) {
    return
  }
  const state = useAppStore.getState()
  if (
    args.shouldActivateOnCompletion &&
    state.activeView === 'terminal' &&
    state.activePendingCreationId === args.creationId
  ) {
    requestBackgroundTerminalWorktreeMount({ worktreeId: args.worktreeId, tabIds: [tab.id] })
    await waitForNativeChatComposerHandoff(
      sourceScope,
      tab.id,
      revealAbandoned,
      HANDOFF_READY_TIMEOUT_MS
    )
  }
  if (abandoned.aborted) {
    return
  }
  const executionHostId = tab.executionHostId ?? getStructuredAgentSessionLaunchOwner(tab.entityId)
  if (!executionHostId) {
    return
  }
  await preparePendingChatDraftHandoff(sourceScope, tab.entityId, {
    workspaceId: tab.worktreeId,
    executionHostId
  })
  if (abandoned.aborted) {
    return
  }
  const selection = revealAbandoned.aborted ? undefined : nativeChatComposerSelection(sourceScope)
  if (selection) {
    captureNativeChatComposerFocusIntent().request(tab.id)
  }
  moveStructuredAgentLaunchDraft(
    { sessionId: tab.entityId, worktreeId: args.worktreeId, executionHostId },
    sourceScope,
    selection
  )
}
