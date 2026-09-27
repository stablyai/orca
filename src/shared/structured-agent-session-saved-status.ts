// A chat's last settled status, saved so a restarted host can list it without replaying its journal.
//
// Only an idle or no-turn projection is saved, keyed by the journal position it was computed at.
// A restart trusts it only when the journal still stands exactly there; anything else is a miss and
// the journal is opened, so a saved copy can go stale but can never be shown stale.

import type { AgentJournalCursor } from './agent-session-journal-types'
import { isAgentJournalTurnOutcome } from './agent-turn-outcome'
import type { StructuredAgentSessionStatusProjection } from './structured-agent-session-projection'

/** Bump whenever the projection or the reducer changes what an idle or no-turn chat projects. */
export const STRUCTURED_AGENT_SESSION_STATUS_PROJECTION_VERSION = 1

export type StructuredAgentSessionSavedStatus = {
  v: number
  /** Where the journal stood when `projection` was computed. */
  cursor: AgentJournalCursor
  projection: StructuredAgentSessionStatusProjection
  /** The journal's `lastActivityAt()` at that position, which dates the row. */
  lastActivityAt: number
}

/** Whether a projection is one a saved copy may hold: settled, so no fence can change it. */
export function isSavableStructuredAgentSessionProjection(
  projection: StructuredAgentSessionStatusProjection
): boolean {
  return projection.status === null || projection.status === 'idle'
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string'
}

/** The saved projection, or null for anything this build did not write: a miss, never an error. */
export function parseStructuredAgentSessionSavedProjection(
  json: string
): StructuredAgentSessionStatusProjection | null {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) {
    return null
  }
  const value: Record<string, unknown> = { ...raw }
  const { status, latestPrompt, lastAssistantMessage, turnOutcome, statusStartedAt } = value
  if (status !== null && status !== 'idle') {
    return null
  }
  if (typeof latestPrompt !== 'string' || !optionalString(lastAssistantMessage)) {
    return null
  }
  if (value.toolName !== undefined || value.toolInput !== undefined) {
    return null
  }
  if (turnOutcome !== undefined && !isAgentJournalTurnOutcome(turnOutcome)) {
    return null
  }
  if (statusStartedAt !== undefined && typeof statusStartedAt !== 'number') {
    return null
  }
  return {
    status,
    latestPrompt,
    ...(typeof lastAssistantMessage === 'string' ? { lastAssistantMessage } : {}),
    ...(isAgentJournalTurnOutcome(turnOutcome) ? { turnOutcome } : {}),
    ...(typeof statusStartedAt === 'number' ? { statusStartedAt } : {})
  }
}
