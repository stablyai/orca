// The pane header's and the tab menu's chat offer for one terminal pane, without a History request.

import type { AppState } from '@/store/types'
import {
  resolvePaneAgentConversation,
  resolvePaneLastAgentConversation
} from '@/lib/ai-vault-tab-title-requests'
import {
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  type ExecutionHostScope
} from '../../../../shared/execution-host'
import {
  adoptsCliConversations,
  CLI_CONVERSATION_ADOPTING_AGENTS,
  type CliConversationRowAgent
} from '../../../../shared/structured-agent-cli-conversation-adoption'
import { resolveAiVaultHostScopeDefaults } from '../right-sidebar/ai-vault-host-scope'
import { getAiVaultResumeWorkspaceExecutionHostId } from '@/lib/ai-vault-resume-target'
import { structuredAgentSessionLaunchFeasible } from '@/lib/agent-session-launch-plan'
import { resolveHostCapabilities } from '@/lib/agent-launch-route-input'
import { STRUCTURED_AGENT_SESSION_RESUME_HISTORY_RUNTIME_CAPABILITY } from '../../../../shared/agent-session/structured-agent-session-surface-capabilities'
import { workspaceKindForWorktreeId } from '../../../../shared/workspace-launch-kind'

/** Skips lookups on hosts where the row's gate can never pass, so no remote scan runs for nothing. */
export function canHostOfferTabSessionMove(hostScope: ExecutionHostScope): boolean {
  if (hostScope === LOCAL_EXECUTION_HOST_ID) {
    return true
  }
  return parseExecutionHostId(hostScope)?.kind === 'runtime'
}

/** Null when the pane has nothing to move; `host-update-required` when its host predates chat resume. */
export type PaneResumeInNewChatOffer = 'available' | 'host-update-required' | null

/** The pane's known identity and launch route, without a History request. */
export function resolvePaneResumeInNewChatOffer(
  state: AppState,
  pane: { worktreeId: string; paneKey: string }
): PaneResumeInNewChatOffer {
  const conversation = resolvePaneLastAgentConversation(state, pane, adoptsCliConversations)
  if (!conversation) {
    return null
  }
  if (!canChatRunAgentIn(state, conversation.worktreeId, conversation.agent)) {
    return null
  }
  if (conversation.executionHostId === LOCAL_EXECUTION_HOST_ID) {
    return 'available'
  }
  // Older hosts' create schemas reject resumeFrom; unverified capabilities offer nothing yet.
  const capabilities = resolveHostCapabilities(state, conversation.executionHostId)
  if (!capabilities) {
    return null
  }
  return capabilities.includes(STRUCTURED_AGENT_SESSION_RESUME_HISTORY_RUNTIME_CAPABILITY)
    ? 'available'
    : 'host-update-required'
}

/** The row gate's launch-route half, so a project the chat route refuses (WSL, repair) hides it. */
function canChatRunAgentIn(
  state: AppState,
  worktreeId: string,
  agent: CliConversationRowAgent
): boolean {
  const hostScope = resolveAiVaultHostScopeDefaults(
    getAiVaultResumeWorkspaceExecutionHostId(state, worktreeId),
    worktreeId
  ).defaultExecutionHostScope
  return (
    canHostOfferTabSessionMove(hostScope) &&
    CLI_CONVERSATION_ADOPTING_AGENTS[agent].some((adopting) =>
      structuredAgentSessionLaunchFeasible(state, {
        agent: adopting,
        workspace: { kind: workspaceKindForWorktreeId(worktreeId), worktreeId },
        settings: state.settings
      })
    )
  )
}

/** The pane header's switch: `conversation-unknown` while the agent hasn't reported one yet. */
export type PaneHeaderSwitchOffer = PaneResumeInNewChatOffer | 'conversation-unknown'

/** Shown while the pane runs an agent Chat UI can take over, where Chat UI can run, as Hand Off
 *  shows (Brennan 11-01); disabled until the agent's conversation is known; none at a shell. */
export function resolvePaneHeaderSwitchOffer(
  state: AppState,
  pane: { worktreeId: string; paneKey: string; liveAgent: string | null; stopped?: boolean }
): PaneHeaderSwitchOffer | null {
  if (
    !adoptsCliConversations(pane.liveAgent) ||
    !canChatRunAgentIn(state, pane.worktreeId, pane.liveAgent)
  ) {
    return null
  }
  // A running agent offers only the conversation its own run reported, never a remembered one
  // from an earlier run in this pane; a pane a failed switch stopped offers the one it stopped.
  if (!pane.stopped && !resolvePaneAgentConversation(state, pane, adoptsCliConversations)) {
    return 'conversation-unknown'
  }
  return resolvePaneResumeInNewChatOffer(state, pane) ?? 'conversation-unknown'
}

export function canPaneOfferResumeInNewChat(
  state: AppState,
  pane: { worktreeId: string; paneKey: string }
): boolean {
  return resolvePaneResumeInNewChatOffer(state, pane) !== null
}
