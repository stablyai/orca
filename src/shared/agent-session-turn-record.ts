// Read both current turn items and legacy turnLifecycle status rows still sent to older clients.

import {
  AGENT_JOURNAL_TURN_OUTCOMES,
  type AgentJournalItemBody,
  type AgentJournalStatusItem,
  type AgentJournalTurnItem,
  type AgentJournalTurnLifecycle,
  type AgentJournalTurnOutcome
} from './agent-session-journal-types'
import { isAdmissibleAgentSessionContextUsage } from './agent-session-context-usage-schema'
import { agentTurnLifecycleText } from './agent-turn-lifecycle-text'
import { tuiAgentDisplayName } from './tui-agent-display-names'

export function readAgentJournalTurn(
  body: AgentJournalItemBody | undefined
): AgentJournalTurnLifecycle | null {
  if (!body) {
    return null
  }
  if (body.kind === 'turn') {
    const { kind: _kind, ...turn } = body
    return turn
  }
  return body.kind === 'status' ? (body.turnLifecycle ?? null) : null
}

export function isRunningAgentJournalTurn(body: AgentJournalItemBody | undefined): boolean {
  return readAgentJournalTurn(body)?.state === 'running'
}

/** Decoded outcome is an unchecked open string despite canonical typing; narrow it through the reader below. */
export type AgentJournalTurnOutcomeSource = Omit<AgentJournalTurnLifecycle, 'outcome'> & {
  outcome?: string
}

/** Read verdicts only here: absent/newer/legacy outcomes return null (unknown), never success. completed also covers provider API errors; the open persisted string is not proof of a known typed arm. */
export function readAgentJournalTurnOutcome(
  turn: AgentJournalTurnOutcomeSource | null | undefined
): AgentJournalTurnOutcome | null {
  const outcome = turn?.outcome
  return AGENT_JOURNAL_TURN_OUTCOMES.find((known) => known === outcome) ?? null
}

export function agentJournalTurnBody(turn: AgentJournalTurnLifecycle): AgentJournalTurnItem {
  const {
    turnId,
    state,
    outcome,
    userItemId,
    startedAt,
    requestedAt,
    completedAt,
    durationMs,
    contextUsage: savedContextUsage,
    providerTurnId,
    ...extensions
  } = turn
  return {
    ...extensions,
    kind: 'turn',
    turnId,
    state,
    ...(nonemptyString(outcome) ? { outcome } : {}),
    ...(nonemptyString(userItemId) ? { userItemId } : {}),
    ...(positiveTime(startedAt) ? { startedAt } : {}),
    ...(positiveTime(requestedAt) ? { requestedAt } : {}),
    ...(positiveTime(completedAt) ? { completedAt } : {}),
    ...(typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs >= 0
      ? { durationMs }
      : {}),
    ...(isAdmissibleAgentSessionContextUsage(savedContextUsage)
      ? { contextUsage: savedContextUsage }
      : {}),
    ...(nonemptyString(providerTurnId) ? { providerTurnId } : {})
  }
}

function nonemptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function positiveTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

/** Legacy pre-v3 carrier: prefer the known session agent (command turns key as orca), else read lifecycle legacy:<agent> identity. */
export function legacyAgentJournalTurnStatusBody(
  turn: AgentJournalTurnLifecycle,
  itemId: string,
  sessionAgent?: string | null
): AgentJournalStatusItem {
  const agent = sessionAgent ?? /^legacy:([^:]+):/.exec(itemId)?.[1] ?? null
  const name = agent === null ? 'Agent' : (tuiAgentDisplayName(agent) ?? agent)
  return { kind: 'status', text: agentTurnLifecycleText(name, turn.state), turnLifecycle: turn }
}

/**
 * The opener a turn record names once a write revises it, for every writer. A record keeps the
 * saved row it names (aliases resolved), so a write naming none or another row never erases or
 * moves it; a write may refine a record naming itself, or a row not saved yet, to its opener.
 */
export function revisedAgentJournalTurnAnchor(
  recordItemId: string,
  saved: string | undefined,
  next: string | undefined,
  savedRow: (key: string) => string | undefined
): string | undefined {
  const row = saved === undefined || saved === recordItemId ? undefined : savedRow(saved)
  return row ?? next ?? saved
}
