import type { AgentStatusEntry, AgentType } from '../../../../shared/agent-status-types'
import type { TerminalConversationSelection } from '../../../../shared/terminal-conversation-identity'
import type { HostLeafConversation } from '../../../../shared/terminal-tab-types'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { isNativeChatSupportedAgent } from './native-chat-availability'
import {
  offeredHostLeafAgent,
  selectHostLeafConversation
} from './native-chat-leaf-conversation-identity'

/** Inputs that resolve the active pane to the agent/session/pty triple the
 *  native-chat data + input layers need. Kept as a plain shape (not the live
 *  store or pane-manager singleton) so the resolver stays pure and unit-
 *  testable — call sites read the agent-status entry and the runtime ptyId for
 *  the pane's `paneKey` before calling. */
export type NativeChatPaneResolutionInput = {
  /** Composite `${tabId}:${leafId}` key of the active leaf. */
  paneKey: string
  /** The coding-agent Orca launched in this terminal, if any (from TerminalTab).
   *  Drives the agent label when no live status entry has reported one yet. */
  launchAgent?: TuiAgent | null
  /** Live agent-status entry for this pane, when one exists. Carries the
   *  captured `providerSession` (the agent's own session id) once the agent has
   *  reported it, plus the detected `agentType`. */
  agentStatusEntry?: AgentStatusEntry
  /** Runtime PTY id bound to this pane. ptyId is pane-manager runtime state, so
   *  it's passed in rather than looked up inside this pure function. */
  ptyId: string | null
  /** Agent identity resolved from trusted terminal title/foreground signals.
   *  Fallback only: launch metadata and hook status remain authoritative. */
  resolvedAgent?: TuiAgent | null
  /** A paired host's conversation for this exact leaf, when it published one. */
  conversation?: HostLeafConversation
}

export type NativeChatPaneResolution = {
  agent: AgentType
  /** The agent's own captured session/conversation id, or null before the
   *  agent has reported one (entry exists but no providerSession yet). */
  sessionId: string | null
  /** Authoritative transcript path from the hook, when reported. Preferred over
   *  reconstructing the path from sessionId (recent Claude Code diverges them). */
  transcriptPath: string | null
  ptyId: string | null
  paneKey: string
  /** Whether the address came from the host's field (`address`) or the legacy status read. */
  authority: TerminalConversationSelection['authority']
}

/** Resolve the active pane to `{ agent, sessionId, ptyId, paneKey }`, or null
 *  when the pane runs no agent. A pane qualifies when a live agent-status entry,
 *  launch-time hint, or the same title-derived fallback used by the toggle is
 *  present. sessionId comes from the entry's `providerSession.id` (the captured
 *  agent session id) — null until the agent reports one, so a just-launched
 *  pane resolves without throwing. */
export function resolveNativeChatSession(
  input: NativeChatPaneResolutionInput
): NativeChatPaneResolution | null {
  const agent =
    input.agentStatusEntry?.agentType ??
    offeredHostLeafAgent(input.conversation, input.agentStatusEntry) ??
    input.launchAgent ??
    input.resolvedAgent
  if (!agent || !isNativeChatSupportedAgent(agent)) {
    return null
  }
  const selection = selectHostLeafConversation(input.conversation, input.agentStatusEntry, agent)
  return {
    agent,
    sessionId: selection.address?.providerSession.id ?? null,
    transcriptPath: selection.address?.providerSession.transcriptPath ?? null,
    ptyId: input.ptyId,
    paneKey: input.paneKey,
    authority: selection.authority
  }
}
