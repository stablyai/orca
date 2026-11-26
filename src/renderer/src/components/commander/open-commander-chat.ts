import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { structuredChatWorkspacesBySessionId } from '@/lib/agent-session/tab-identity/structured-chat-tab-index'
import { structuredAgentSessionOwnerForTab } from '@/runtime/native-chat/session-ownership/structured-agent-session-owner'
import { structuredAgentSessionDraftScopeKey } from '../native-chat/drafts/native-chat-draft-scope'
import { openBotHomeTab } from '@/lib/bot-home-navigation'
import { stampBotHost } from '@/lib/bot-catalog-snapshot'
import { useAppStore } from '@/store'
import { selectedCommanderHost } from './selected-commander-host'
import { folderWorkspaceKey } from '../../../../shared/workspace/identity/workspace-scope'
import { CommanderChatOpenResult } from '../../../../shared/rpc-contract/commander-chat'
import { isLoneStructuredAgentSessionConversationCommand } from '../../../../shared/agent-session/view/structured-agent-session-composer'
import { hydrateNativeChatComposerDrafts } from '../native-chat/drafts/native-chat-composer-draft-load'
import { readNativeChatComposerDraft } from '../native-chat/drafts/native-chat-composer-draft-store'
import type { NativeChatComposerDraftOwner } from '../native-chat/drafts/native-chat-composer-draft-storage'
import { appendNativeChatDraftCache } from '../native-chat/drafts/native-chat-draft-views'

export function prepareHandoffDraft(
  sessionId: string,
  text: string,
  owner: NativeChatComposerDraftOwner
): () => void {
  const state = useAppStore.getState()
  const tabs = state.unifiedTabsByWorktree
  const conflictingChat = structuredChatWorkspacesBySessionId(tabs, sessionId).some(
    (id) =>
      id !== owner.workspaceId ||
      tabs[id].some(
        (tab) =>
          tab.contentType === 'agent-session' &&
          tab.entityId === sessionId &&
          structuredAgentSessionOwnerForTab(state, tab) !== owner.executionHostId
      )
  )
  const scopeKey = structuredAgentSessionDraftScopeKey(sessionId)
  const draft = readNativeChatComposerDraft(scopeKey)
  if (
    conflictingChat ||
    (draft.owner &&
      (draft.owner.workspaceId !== owner.workspaceId ||
        draft.owner.executionHostId !== owner.executionHostId))
  ) {
    throw new Error(
      'This chat draft belongs to another workspace. Open its original chat to review it.'
    )
  }
  if (isLoneStructuredAgentSessionConversationCommand(draft.text.trim())) {
    throw new Error(
      'This chat has an unsent command. Open the chat and review that command before resuming.'
    )
  }
  return () => {
    if (!readNativeChatComposerDraft(scopeKey).text.includes(text)) {
      appendNativeChatDraftCache(scopeKey, text, owner)
    }
  }
}

async function openHome(handoff?: { text: string; isCurrent: () => boolean }): Promise<boolean> {
  const { target, hostId } = selectedCommanderHost()
  const isCurrent = (): boolean =>
    selectedCommanderHost().hostId === hostId && (handoff?.isCurrent() ?? true)
  if (!isCurrent()) {
    return false
  }
  const { bot } = CommanderChatOpenResult.parse(
    await callRuntimeRpc<unknown>(target, 'commanderChat.open')
  )
  if (handoff) {
    if (bot.systemRole !== 'commander') {
      throw new Error(
        'This host could not identify its Commander. Update Orca on the host and try again.'
      )
    }
    await hydrateNativeChatComposerDrafts()
  }
  if (!isCurrent()) {
    return false
  }
  const workspaceId = folderWorkspaceKey(bot.folderWorkspaceId)
  return openBotHomeTab(stampBotHost(hostId, bot), {
    destination: 'composer',
    isCurrent,
    prepareDraft: handoff
      ? (sessionId) =>
          prepareHandoffDraft(sessionId, handoff.text, { workspaceId, executionHostId: hostId })
      : undefined
  })
}

export function openCommanderChat(): Promise<boolean> {
  return openHome()
}

export function resumeCommanderHandoff(text: string, isCurrent: () => boolean): Promise<boolean> {
  return text.trim() ? openHome({ text, isCurrent }) : Promise.resolve(false)
}
