import type { AppState } from '@/store/types'
import {
  collectAgentPaneConversations,
  resolvePaneLastAgentConversation
} from '@/lib/ai-vault-tab-title-requests'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import {
  adoptsCliConversations,
  type CliConversationRowAgent
} from '../../../../shared/structured-agent-cli-conversation-adoption'
import { resolvePaneResumeInNewChatOffer } from './tab-session-history-switch'

export type CliChatResumeSource = {
  tabId: string
  workspaceId: string
  paneKey: string
  agent: CliConversationRowAgent
  providerSessionId: string
  executionHostId: ExecutionHostId
  /** The host predates chat resume: show the action disabled and ask for an update. */
  hostUpdateRequired?: true
}

export function resolveCliChatResumeSource(
  state: AppState,
  args: { tab: { id: string; worktreeId: string }; paneKey?: string }
): CliChatResumeSource | null {
  const conversation = args.paneKey
    ? resolvePaneLastAgentConversation(
        state,
        { worktreeId: args.tab.worktreeId, paneKey: args.paneKey },
        adoptsCliConversations
      )
    : collectAgentPaneConversations(state, adoptsCliConversations, {
        runningAgentsOnly: true,
        includeLastReported: true,
        tab: { worktreeId: args.tab.worktreeId, tabId: args.tab.id }
      }).find((candidate) => candidate.tabId === args.tab.id)
  const offer = conversation
    ? resolvePaneResumeInNewChatOffer(state, {
        worktreeId: conversation.worktreeId,
        paneKey: conversation.paneKey
      })
    : null
  if (
    !conversation ||
    conversation.tabId !== args.tab.id ||
    conversation.worktreeId !== args.tab.worktreeId ||
    !offer
  ) {
    return null
  }
  return {
    tabId: conversation.tabId,
    workspaceId: conversation.worktreeId,
    paneKey: conversation.paneKey,
    agent: conversation.agent,
    providerSessionId: conversation.providerSession.id,
    executionHostId: conversation.executionHostId,
    ...(offer === 'host-update-required' ? { hostUpdateRequired: true as const } : {})
  }
}
