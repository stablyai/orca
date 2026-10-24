import { switchIntoOwner } from '../tab-bar/cli-chat-resume-feedback'
import { structuredAgentSessionTargetForHost } from '@/runtime/structured-agent-session-owner'
import {
  cliConversationRowsShareAgent,
  adoptsCliConversations
} from '../../../../shared/structured-agent-cli-conversation-adoption'
import { useAppStore } from '@/store'
import { collectAgentPaneConversations } from '@/lib/ai-vault-tab-title-requests'
import { inPlaceSwitchSupportedNow } from '@/lib/in-place-switch-support'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import { resolveCliChatResumeSource } from '../tab-bar/cli-chat-resume-source'
import { runCliChatResume } from '../tab-bar/cli-chat-resume-run'
import { runNativeChatCliSwitch } from '../tab-bar/native-chat-cli-switch-run'

/** History's "Switch to CLI": in the chat tab's slot when that tab is open in this window, else a
 *  new tab. False when the row's host doesn't switch this agent in place, so the row forks. */
export function switchAiVaultSessionToCli(session: AiVaultSession): boolean {
  const chat = session.structuredSession
  if (!chat || !inPlaceSwitchSupportedNow(session.executionHostId, session.agent)) {
    return false
  }
  const chatTab = useAppStore
    .getState()
    .unifiedTabsByWorktree[chat.workspaceId]?.find(
      (tab) => tab.contentType === 'agent-session' && tab.entityId === chat.sessionId
    )
  void runNativeChatCliSwitch({
    sessionId: chat.sessionId,
    workspaceId: chat.workspaceId,
    executionHostId: session.executionHostId,
    agent: session.agent,
    chatTabId: chatTab?.id ?? null
  })
  return true
}

/** History's "Switch to native chat": in place when a pane in this window last reported the
 *  conversation. False otherwise, so the row opens or reveals its chat in a new tab. */
export function switchAiVaultSessionToNativeChat(session: AiVaultSession): boolean {
  if (
    !adoptsCliConversations(session.agent) ||
    !inPlaceSwitchSupportedNow(session.executionHostId, session.agent)
  ) {
    return false
  }
  const agent = session.agent
  const state = useAppStore.getState()
  const pane = collectAgentPaneConversations(state, adoptsCliConversations, {
    allPanes: true
  }).find(
    (candidate) =>
      candidate.providerSession.id === session.sessionId &&
      cliConversationRowsShareAgent(candidate.agent, agent) &&
      candidate.executionHostId === session.executionHostId
  )
  const source = pane
    ? resolveCliChatResumeSource(state, {
        tab: { id: pane.tabId, worktreeId: pane.worktreeId },
        paneKey: pane.paneKey
      })
    : null
  if (!source) {
    const target = structuredAgentSessionTargetForHost(session.executionHostId)
    if (!target || !session.structuredSession || !adoptsCliConversations(session.agent)) {
      return false
    }
    void switchIntoOwner(
      { agent: session.agent, tabId: '', workspaceId: session.structuredSession.workspaceId },
      session.structuredSession,
      target
    )
    return true
  }
  void runCliChatResume(source)
  return true
}
