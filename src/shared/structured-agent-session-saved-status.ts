// A native chat's last status, saved with the agent status store so a restart lists every chat's
// status without opening its history. Only the journal's half is kept: the record owns the chat's
// agent, workspace, name and options, and the agent, its Stop, tools and child work end with the
// process.

import type { AgentSessionStatusSummary } from './agent-session-wire'
import { isAgentTurnOutcome } from './agent-turn-outcome'

export type SavedStructuredSessionSummary = Pick<
  AgentSessionStatusSummary,
  | 'sessionId'
  | 'status'
  | 'latestPrompt'
  | 'lastAssistantMessage'
  | 'turnOutcome'
  | 'statusStartedAt'
  | 'updatedAt'
>

export type SavedStructuredSessionStatus = { summary: SavedStructuredSessionSummary }

/** A saved entry as startup reads it: `saved` is null for one this build cannot parse. */
export type SavedStructuredSessionEntry = {
  sessionId: string
  saved: SavedStructuredSessionStatus | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function savedStatus(value: unknown): AgentSessionStatusSummary['status'] | undefined {
  return value === null || value === 'working' || value === 'attention' || value === 'idle'
    ? value
    : undefined
}

/** The summary's journal fields, or null for anything malformed; saving and loading share it. */
export function savedStructuredSessionSummary(
  value: unknown
): SavedStructuredSessionSummary | null {
  if (!isRecord(value)) {
    return null
  }
  const status = savedStatus(value.status)
  const { sessionId, latestPrompt, lastAssistantMessage, updatedAt, statusStartedAt } = value
  if (
    status === undefined ||
    typeof sessionId !== 'string' ||
    typeof latestPrompt !== 'string' ||
    !isTimestamp(updatedAt)
  ) {
    return null
  }
  return {
    sessionId,
    status,
    latestPrompt,
    ...(typeof lastAssistantMessage === 'string' && lastAssistantMessage.length > 0
      ? { lastAssistantMessage }
      : {}),
    ...(status === 'idle' && isAgentTurnOutcome(value.turnOutcome)
      ? { turnOutcome: value.turnOutcome }
      : {}),
    updatedAt,
    ...(isTimestamp(statusStartedAt) ? { statusStartedAt } : {})
  }
}

export function parseSavedStructuredSessionStatus(
  sessionId: string,
  value: unknown
): SavedStructuredSessionStatus | null {
  const summary = isRecord(value) ? savedStructuredSessionSummary(value.summary) : null
  return summary?.sessionId === sessionId ? { summary } : null
}

/** A save is owed when what a restart would show changes, never for a streamed delta. */
export function savedStructuredSessionStatusChanged(
  previous: SavedStructuredSessionSummary | undefined,
  next: SavedStructuredSessionSummary
): boolean {
  return !previous || previous.status !== next.status || previous.turnOutcome !== next.turnOutcome
}
