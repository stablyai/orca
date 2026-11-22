import type { AgentProviderSessionMetadata } from '../../agent-session/lifecycle/agent-session-resume'

/** The conversation a restart resumes: the one the chat names, else the pane's newest known one. */
export function pickPaneAgentRestartSession(
  /** The pane's known sessions, newest evidence first (status row, saved record, last running). */
  known: readonly (AgentProviderSessionMetadata | null)[],
  requestedSessionId: string | null,
  /** The chat's named session built from its id alone, used when nothing richer matches it. */
  named: AgentProviderSessionMetadata | null
): AgentProviderSessionMetadata | null {
  const sessions = known.filter((session) => session !== null)
  if (!requestedSessionId) {
    return sessions[0] ?? null
  }
  // A newer session in the pane (a restart) must not stand in for the one the chat showed.
  return sessions.find((session) => session.id === requestedSessionId) ?? named
}
