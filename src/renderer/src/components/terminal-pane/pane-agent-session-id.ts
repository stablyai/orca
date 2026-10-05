import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session-resume'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { PaneForegroundAgentEntry } from '../../store/slices/pane-foreground-agent'
import {
  findHostLeafConversation,
  offeredHostLeafAgent,
  selectHostLeafConversation
} from '../native-chat/native-chat-leaf-conversation-identity'

export type PaneAgentSessionIdState = {
  agentStatusByPaneKey: Record<string, AgentStatusEntry | undefined>
  sleepingAgentSessionsByPaneKey: Record<string, SleepingAgentSessionRecord | undefined>
  paneForegroundAgentByPaneKey: Record<string, PaneForegroundAgentEntry | undefined>
  tabsByWorktree: Record<string, readonly TerminalTab[]>
}

/** Resolves the provider session owned by one exact terminal pane, while its agent is still live. */
export function resolvePaneAgentSessionId(
  state: PaneAgentSessionIdState,
  paneKey: string
): string | null {
  // OSC 133;D proves the pane is back at the shell. The durable record outlives that exit on
  // purpose (cold restore resumes from it), so gate it here too — otherwise the gate would only
  // hold for panes whose agent has no resumable record.
  if (state.paneForegroundAgentByPaneKey[paneKey]?.shellForeground === true) {
    return null
  }
  const live = state.agentStatusByPaneKey[paneKey]
  const parsed = parsePaneKey(paneKey)
  // Why this leaf only: a split sibling's conversation is never this pane's.
  const conversation = parsed
    ? findHostLeafConversation(state.tabsByWorktree, parsed.tabId, parsed.leafId)
    : undefined
  const selection = selectHostLeafConversation(
    conversation,
    live,
    live?.agentType ?? offeredHostLeafAgent(conversation, live)
  )
  if (selection.authority === 'address') {
    return selection.address?.providerSession.id ?? null
  }
  if (live && live.restoredUnconfirmed !== true) {
    return live.providerSession?.id ?? null
  }
  return state.sleepingAgentSessionsByPaneKey[paneKey]?.providerSession.id ?? null
}
