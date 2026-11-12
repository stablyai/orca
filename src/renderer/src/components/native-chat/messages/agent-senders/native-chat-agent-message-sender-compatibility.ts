import type { AppState } from '@/store/types'
import { getKnownExecutionHostIdForWorktree } from '@/lib/workspace/ownership/worktree-runtime-owner'
import { structuredAgentSessionPaneKey } from '../../../../../../shared/agent-session/view/structured-agent-session-projection'
import type { AgentMessageSender } from '../../../../../../shared/agent-session/agent-session-message-source'
import type { SenderLocation } from './native-chat-agent-message-sender-source'
import { findAgentMessageSenderChatTab } from './native-chat-agent-message-sender-label'

/** Compatibility for hosts that predate sender associations. */
export function locateLegacyAgentMessageSender(
  state: AppState,
  sender: AgentMessageSender,
  owner: string
): SenderLocation | undefined {
  const { address, orcaSessionId: sessionId, terminalHandle: handle } = sender.party
  if (!address || address.startsWith('dispatch:')) {
    return undefined
  }
  const chatTab = sessionId ? findAgentMessageSenderChatTab(state, sessionId, owner) : undefined
  let paneKey = chatTab && structuredAgentSessionPaneKey(chatTab.id, chatTab.entityId)
  if (!paneKey && handle) {
    const statuses = state.agentStatusByPaneKey
    const matches = Array.from(statuses.projection.handleKeys(handle)).filter((key) => {
      const row = statuses.get(key)
      return row?.worktreeId && getKnownExecutionHostIdForWorktree(state, row.worktreeId) === owner
    })
    paneKey = matches.length === 1 ? matches[0] : undefined
  }

  const worktreeId =
    chatTab?.worktreeId ??
    (paneKey ? state.agentStatusByPaneKey.get(paneKey)?.worktreeId : undefined)
  return worktreeId && paneKey
    ? { host: owner, worktreeId, paneKey, agentType: chatTab?.agentSessionAgent }
    : undefined
}
