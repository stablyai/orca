// One reader for the turn record in both of its journal shapes: the `turn`
// item this build writes, and the status row with `turnLifecycle` that older
// hosts wrote and that older clients still receive.

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

/** A turn record as DECODED, with the verdict left open. The journal schema
 *  type-checks `outcome` as a string and never against the arm set, so this is
 *  the shape a reader really holds — `AgentJournalTurnLifecycle` is assignable
 *  to it, and narrowing is what the reader below is for. */
export type AgentJournalTurnOutcomeSource = Omit<AgentJournalTurnLifecycle, 'outcome'> & {
  outcome?: string
}

/**
 * The provider's verdict on a turn, or null when nothing recorded one.
 *
 * The only safe way to ask. The persisted field is an open string so a newer
 * host's row stays readable, which means the decoded value is typed as an arm
 * this build knows without having been checked against one. Everything that
 * cannot be placed — absent, an arm from a later vocabulary, a legacy row whose
 * `completed` was written before outcomes existed — answers null, and null is
 * UNKNOWN. A caller must never treat it as success: the host writes `completed`
 * for a turn the provider ended with an API error.
 */
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

/** The pre-v3 carrier, for clients that predate the `turn` item. The agent name is the session's
 *  when the caller knows it — a command's turn is keyed `orca:…` whatever agent ran it — else it
 *  comes from the lifecycle identity (`legacy:<agent>:…`). */
export function legacyAgentJournalTurnStatusBody(
  turn: AgentJournalTurnLifecycle,
  itemId: string,
  sessionAgent?: string | null
): AgentJournalStatusItem {
  const agent = sessionAgent ?? /^legacy:([^:]+):/.exec(itemId)?.[1] ?? null
  const name = agent === null ? 'Agent' : (tuiAgentDisplayName(agent) ?? agent)
  return { kind: 'status', text: agentTurnLifecycleText(name, turn.state), turnLifecycle: turn }
}
