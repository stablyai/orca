import { collectAgentPaneConversations } from '@/lib/ai-vault-tab-title-requests'
import type { ConfirmationDialogContextValue } from '@/components/confirmation-dialog-context'
import type { AiVaultOriginalPaneTarget } from './ai-vault-original-pane'
import {
  cliConversationRowsShareAgent,
  adoptsCliConversations
} from '../../../../shared/structured-agent-cli-conversation-adoption'
import { inPlaceSwitchSupportedNow } from '@/lib/in-place-switch-support'
import { useAppStore } from '@/store'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import { resolveCliChatResumeSource } from '../tab-bar/cli-chat-resume-source'
import {
  runConversationSwitch,
  runNativeChatCliSwitch,
  type ConversationSwitch
} from '@/lib/conversation-surface-switch'

/** History's "Switch to CLI": in the chat tab's slot when that tab is open in this window, else a
 *  new tab. False when the row's host doesn't switch this agent in place, so the row forks. */
export function switchAiVaultSessionToCli(
  session: AiVaultSession,
  confirm?: ConfirmationDialogContextValue
): boolean {
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
    confirm,
    sessionId: chat.sessionId,
    workspaceId: chat.workspaceId,
    executionHostId: session.executionHostId,
    agent: session.agent,
    chatTabId: chatTab?.id ?? null,
    history: session
  })
  return true
}

/** History's "Switch to Chat UI": in place when a pane in this window last reported the
 *  conversation. False otherwise, so the row opens or reveals its chat in a new tab. */
export function switchAiVaultSessionToNativeChat(
  session: AiVaultSession,
  workspaceId?: string,
  originalPaneTarget?: AiVaultOriginalPaneTarget | null,
  confirm?: ConfirmationDialogContextValue
): boolean {
  if (!inPlaceSwitchSupportedNow(session.executionHostId, session.agent)) {
    return false
  }
  const source = historyPaneSource(session, originalPaneTarget)
  if (!source) {
    const subject = historyConversationSwitch(session, 'chat', workspaceId)
    if (!subject) {
      return false
    }
    void runConversationSwitch({ ...subject, confirm })
    return true
  }
  void runConversationSwitch({ direction: 'chat', ...source, source, history: session, confirm })
  return true
}

/** History can address a closed chat without opening it merely to inspect availability. */
export function historyConversationSwitch(
  session: AiVaultSession,
  direction: 'chat' | 'terminal',
  workspaceId?: string,
  originalPaneTarget?: AiVaultOriginalPaneTarget | null
): ConversationSwitch | null {
  const chat = session.structuredSession
  return chat || direction === 'chat'
    ? {
        direction,
        agent: session.agent,
        executionHostId: session.executionHostId,
        workspaceId: chat?.workspaceId ?? workspaceId ?? '',
        sessionId: chat?.sessionId,
        history: session,
        source:
          direction === 'chat'
            ? (historyPaneSource(session, originalPaneTarget) ?? undefined)
            : undefined,
        platform: session.executionHostPlatform ?? undefined
      }
    : null
}

function historyPaneSource(session: AiVaultSession, pane?: AiVaultOriginalPaneTarget | null) {
  const agent = session.agent
  if (!adoptsCliConversations(agent)) {
    return null
  }
  const location =
    pane ??
    collectAgentPaneConversations(useAppStore.getState(), adoptsCliConversations).find(
      (candidate) =>
        candidate.executionHostId === session.executionHostId &&
        candidate.providerSession.id === session.sessionId &&
        cliConversationRowsShareAgent(candidate.agent, agent)
    )
  if (!location) {
    return null
  }
  const source = resolveCliChatResumeSource(useAppStore.getState(), {
    tab: { id: location.tabId, worktreeId: location.worktreeId },
    paneKey: location.paneKey
  })
  return source &&
    source.executionHostId === session.executionHostId &&
    source.providerSessionId === session.sessionId &&
    cliConversationRowsShareAgent(source.agent, agent)
    ? source
    : null
}
