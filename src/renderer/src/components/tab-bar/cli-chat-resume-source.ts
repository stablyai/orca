import type { AppState } from '@/store/types'
import {
  collectAgentPaneConversations,
  resolvePaneAgentConversation
} from '@/lib/ai-vault-tab-title-requests'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../../shared/execution-host'
import {
  adoptsCliConversations,
  type CliConversationRowAgent
} from '../../../../shared/structured-agent-cli-conversation-adoption'
import { canPaneOfferResumeInNewChat } from './tab-session-history-switch'

export type CliChatResumeSource = {
  tabId: string
  workspaceId: string
  paneKey: string
  agent: CliConversationRowAgent
  providerSessionId: string
  executionHostId: ExecutionHostId
}

export function resolveCliChatResumeSource(
  state: AppState,
  args: { tab: { id: string; worktreeId: string }; paneKey?: string }
): CliChatResumeSource | null {
  const conversation = args.paneKey
    ? resolvePaneAgentConversation(
        state,
        { worktreeId: args.tab.worktreeId, paneKey: args.paneKey },
        adoptsCliConversations
      )
    : collectAgentPaneConversations(state, adoptsCliConversations, {
        runningAgentsOnly: true
      }).find((candidate) => candidate.tabId === args.tab.id)
  if (
    !conversation ||
    conversation.tabId !== args.tab.id ||
    conversation.worktreeId !== args.tab.worktreeId ||
    conversation.executionHostId !== LOCAL_EXECUTION_HOST_ID ||
    !canPaneOfferResumeInNewChat(state, {
      worktreeId: conversation.worktreeId,
      paneKey: conversation.paneKey
    })
  ) {
    return null
  }
  return {
    tabId: conversation.tabId,
    workspaceId: conversation.worktreeId,
    paneKey: conversation.paneKey,
    agent: conversation.agent,
    providerSessionId: conversation.providerSession.id,
    executionHostId: conversation.executionHostId
  }
}
