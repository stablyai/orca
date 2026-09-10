import type { AgentStatusEntry, AgentType } from '../../../../shared/agent-status-types'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { isNativeChatSupportedAgent } from './native-chat-availability'

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
  const agent = input.agentStatusEntry?.agentType ?? input.launchAgent ?? input.resolvedAgent
  if (!agent || !isNativeChatSupportedAgent(agent)) {
    return null
  }
  return {
    agent,
    sessionId: input.agentStatusEntry?.providerSession?.id ?? null,
    transcriptPath: input.agentStatusEntry?.providerSession?.transcriptPath ?? null,
    ptyId: input.ptyId,
    paneKey: input.paneKey
  }
}

/** Bug 1 fix (wave 7): `resolveNativeChatSession`'s own `sessionId` comes
 *  from the agent-status hook chain (`agentStatusEntry.providerSession.id`),
 *  which never delivers for omp panes (open item 2) — it stays null forever,
 *  so a transcript read keyed on it alone can never find anything, even
 *  after a completed turn. Prefer the wave-4 resolved OMP identity instead
 *  (Decision 2's on-disk resolver, published once known by the
 *  TerminalPane-anchored RPC ownership hook and kept sticky across the
 *  pane's later ptyId churn — `ompRpcChatOwnershipByPaneKey`); fall back to
 *  the hook value when no resolved identity exists yet, which keeps every
 *  non-omp agent's existing behavior unchanged.
 *
 *  `publishedOmpSessionId` outranks both: it is `session.sessionId` as the RPC
 *  child that owns the pane published it on `session_info_update`, so it is
 *  ground truth about which session the pane is in. The on-disk resolver above
 *  degrades to an mtime guess whenever no breadcrumb is available, and in a cwd
 *  holding several sessions that guess can name the wrong transcript. Null
 *  until a builtin republishes the session, so it never displaces a resolved
 *  identity with "unknown". */
export function resolveEffectiveNativeChatSessionId(
  hookSessionId: string | null,
  resolvedOmpSessionId: string | null,
  publishedOmpSessionId: string | null = null
): string | null {
  return publishedOmpSessionId ?? resolvedOmpSessionId ?? hookSessionId
}
