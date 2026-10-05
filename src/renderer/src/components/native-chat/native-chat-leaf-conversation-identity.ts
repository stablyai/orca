import type { AgentStatusEntry, AgentType } from '../../../../shared/agent-status-types'
import type { HostLeafConversation, TerminalTab } from '../../../../shared/terminal-tab-types'
import {
  offeredConversationAgent,
  selectTerminalConversation,
  type TerminalConversationSelection,
  type TerminalConversationTabFields
} from '../../../../shared/terminal-conversation-identity'

// Kept out of the tab-strip agent projection so completion and unread code never read identity.

/** The paired host's conversation for exactly this leaf; never a sibling's. */
export function hostLeafConversation(
  tab: Pick<TerminalTab, 'hostConversationByLeafId'> | null | undefined,
  leafId: string | null | undefined
): HostLeafConversation | undefined {
  return leafId ? tab?.hostConversationByLeafId?.[leafId] : undefined
}

/** Store lookup that allocates nothing, so a selector can return the mirrored entry itself. */
export function findHostLeafConversation(
  tabsByWorktree: Readonly<Record<string, readonly TerminalTab[]>>,
  terminalTabId: string,
  leafId: string | null | undefined
): HostLeafConversation | undefined {
  if (!leafId) {
    return undefined
  }
  for (const worktreeId in tabsByWorktree) {
    for (const tab of tabsByWorktree[worktreeId] ?? []) {
      if (tab.id === terminalTabId) {
        return tab.hostConversationByLeafId?.[leafId]
      }
    }
  }
  return undefined
}

/** For tab-wide readers: the one mirrored leaf, only when the tab has exactly one. */
export function soleHostConversationLeafId(
  tab: Pick<TerminalTab, 'hostConversationByLeafId'> | null | undefined
): string | undefined {
  let sole: string | undefined
  for (const leafId in tab?.hostConversationByLeafId ?? {}) {
    if (sole) {
      return undefined
    }
    sole = leafId
  }
  return sole
}

function toTabFields(
  conversation: HostLeafConversation | undefined,
  statusEntry: AgentStatusEntry | undefined
): TerminalConversationTabFields {
  return {
    agentStatus: statusEntry,
    conversationIdentity: conversation?.identity,
    conversationOfferedWithoutStatus: conversation?.offeredWithoutStatus === true || undefined
  }
}

/** The identity's agent only on an offered statusless leaf; a genuine status never borrows it. */
export function offeredHostLeafAgent(
  conversation: HostLeafConversation | undefined,
  statusEntry: AgentStatusEntry | undefined
): AgentType | null {
  return offeredConversationAgent(toTabFields(conversation, statusEntry))
}

export function selectHostLeafConversation(
  conversation: HostLeafConversation | undefined,
  statusEntry: AgentStatusEntry | undefined,
  agent: AgentType | null | undefined
): TerminalConversationSelection {
  return selectTerminalConversation({
    conversationIdentity: conversation?.identity,
    conversationOfferedWithoutStatus: conversation?.offeredWithoutStatus === true || undefined,
    agentStatus: statusEntry,
    agent
  })
}

const NO_OFFERED_AGENTS: Readonly<Record<string, AgentType>> = Object.freeze({})

/** Per leaf of one tab, the agent the host offers with a statusless conversation. Callers rank a
 *  leaf's detected (status) agent first, so the desktop's own status is not consulted here. */
export function selectOfferedHostConversationAgentsByLeaf(
  tab: Pick<TerminalTab, 'hostConversationByLeafId'> | null | undefined
): Readonly<Record<string, AgentType>> {
  let byLeafId: Record<string, AgentType> | undefined
  for (const leafId in tab?.hostConversationByLeafId ?? {}) {
    const agent = offeredHostLeafAgent(tab?.hostConversationByLeafId?.[leafId], undefined)
    if (agent) {
      byLeafId ??= {}
      byLeafId[leafId] = agent
    }
  }
  return byLeafId ?? NO_OFFERED_AGENTS
}
