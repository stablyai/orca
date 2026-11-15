import type { AppState } from '@/store/types'
import { getKnownExecutionHostIdForWorktree } from '@/lib/workspace/ownership/worktree-runtime-owner'
import { structuredAgentSessionOwnerInputs } from '@/runtime/native-chat/session-ownership/structured-agent-session-owner'
import { structuredAgentSessionPaneKey } from '../../../../../../shared/agent-session/view/structured-agent-session-projection'
import type { AgentStatusEntry } from '../../../../../../shared/agent-status/contracts/agent-status-types'
import type { AgentMessageSender } from '../../../../../../shared/agent-session/agent-session-message-source'
import type { SenderLocation } from './native-chat-agent-message-sender-source'
import { findAgentMessageSenderChatTab } from './native-chat-agent-message-sender-label'

const handleIndexes = new WeakMap<
  object,
  { inputs: unknown[]; index: Map<string, Map<string | null, AgentStatusEntry[]>> }
>()
function byHandle(state: AppState, source: AppState['agentStatusByPaneKey']) {
  const inputs = structuredAgentSessionOwnerInputs(state)
  let cached = handleIndexes.get(source)
  if (!cached || inputs.some((value, index) => value !== cached?.inputs[index])) {
    const index = new Map<string, Map<string | null, AgentStatusEntry[]>>()
    const owners = new Map<string, string | null>()
    for (const entry of Object.values(source)) {
      if (!entry.terminalHandle || !entry.worktreeId) {
        continue
      }
      if (!owners.has(entry.worktreeId)) {
        owners.set(entry.worktreeId, getKnownExecutionHostIdForWorktree(state, entry.worktreeId))
      }
      const owner = owners.get(entry.worktreeId) ?? null
      let byHost = index.get(entry.terminalHandle)
      if (!byHost) {
        byHost = new Map()
        index.set(entry.terminalHandle, byHost)
      }
      const entries = byHost.get(owner) ?? []
      entries.push(entry)
      byHost.set(owner, entries)
    }
    cached = { inputs, index }
    handleIndexes.set(source, cached)
  }
  return cached.index
}

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
    const matches = byHandle(state, state.agentStatusByPaneKey).get(handle)?.get(owner) ?? []
    paneKey = matches.length === 1 ? matches[0].paneKey : undefined
  }

  const worktreeId =
    chatTab?.worktreeId ?? (paneKey ? state.agentStatusByPaneKey[paneKey]?.worktreeId : undefined)
  return worktreeId && paneKey
    ? { host: owner, worktreeId, paneKey, agentType: chatTab?.agentSessionAgent }
    : undefined
}
