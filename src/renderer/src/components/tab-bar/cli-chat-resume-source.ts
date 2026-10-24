import { useAppStore } from '@/store'
import {
  useInPlaceSwitchCapability,
  inPlaceSwitchSupportedNow
} from '@/lib/in-place-switch-support'
import { getExecutionHostIdForWorktree } from '@/lib/worktree-runtime-owner'
import type { AppState } from '@/store/types'
import {
  collectAgentPaneConversations,
  panePtyId,
  resolvePaneLastAgentConversation
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
  /** The pane's PTY when this was resolved; only that execution may be retired. */
  ptyId: string | undefined
}

/** The pane's last reported conversation, or the one the host launched in its current PTY. */
export function resolveCliChatResumeSource(
  state: AppState,
  args: { tab: { id: string; worktreeId: string }; paneKey?: string }
): CliChatResumeSource | null {
  const paneConversation = (paneKey: string) =>
    resolvePaneLastAgentConversation(
      state,
      { worktreeId: args.tab.worktreeId, paneKey },
      adoptsCliConversations
    )
  const conversation = args.paneKey
    ? paneConversation(args.paneKey)
    : collectAgentPaneConversations(state, adoptsCliConversations, {
        tab: { worktreeId: args.tab.worktreeId, tabId: args.tab.id }
      }).find((candidate) => candidate.tabId === args.tab.id)
  if (
    !conversation ||
    conversation.tabId !== args.tab.id ||
    conversation.worktreeId !== args.tab.worktreeId ||
    // A paired host moves a terminal's conversation only once it switches that agent in place.
    (conversation.executionHostId !== LOCAL_EXECUTION_HOST_ID &&
      !inPlaceSwitchSupportedNow(conversation.executionHostId, conversation.agent)) ||
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
    executionHostId: conversation.executionHostId,
    ptyId: panePtyId(state, conversation.paneKey)
  }
}

/** Capability settlement must re-render readers even when pane state did not change. */
export function useCliChatResumeCapability(
  worktreeId: string,
  agent = 'codex'
): boolean | undefined {
  const host = useAppStore((state) => getExecutionHostIdForWorktree(state, worktreeId))
  return useInPlaceSwitchCapability(host, agent)
}
