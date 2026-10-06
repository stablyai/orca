import type { AgentJournalTurnOutcome } from './agent-session-journal-types'
import { agentSessionScopeKey, type AgentSessionExecutionLocation } from './agent-session-record'

// Turn completion feed: the per-turn EDGE beside the status feed's STATE.

/**
 * The session's latest request reaching a terminal outcome — a root turn, or a send the agent or
 * its start refused — derived by the EXECUTION HOST at journal commit.
 *
 * This is the EDGE, with turn identity; `AgentSessionStatusSummary.turnOutcome` is the STATE.
 * The summary carries the verdict only while the session is idle, as a fact about the main agent's
 * last turn that a status reader may act on (attention alerts, the `mainAgent.outcome` row field),
 * and never a turn id: a reader that needs to know WHICH turn finished, or to react exactly once
 * per finish, subscribes here. Re-broadcasting the summary on every status change therefore
 * repeats a state, not a completion.
 *
 * `outcome` is the journal's recorded verdict (the provider's, a stop, or the host's supersede) and
 * is never inferred — a turn the host only observed ending carries no outcome and produces no event
 * at all, because absent means UNKNOWN, not success.
 */
export type AgentSessionTurnCompletion = {
  /** Host-and-workspace scope; a bare provider turn id is not globally unique. */
  scope: AgentSessionExecutionLocation
  sessionId: string
  /** The request's identity: the root turn's id, or for a send refused before any turn, that
   *  send's journal item key. Neither is minted here. */
  turnId: string
  outcome: AgentJournalTurnOutcome
  /** Execution host's clock at journal commit. */
  completedAt: number
  /** The request settled while a prompt waits on the user. Absent otherwise, and from older hosts. */
  awaitingUser?: true
}

/**
 * LIVE-ONLY: there is no snapshot arm and no replay arm, by decision. A subscriber is told what
 * completes while it is subscribed and nothing else; completions that land while it is away are
 * dropped rather than queued, so nothing durable can strand. On reconnect the client baselines.
 */
export type AgentSessionTurnCompletionEvent =
  | { type: 'completion'; completion: AgentSessionTurnCompletion }
  | { type: 'end' }

/** Delivery dedupe address. Unread is idempotent and does not need it; mobile fanout does. */
export function agentSessionTurnCompletionKey(completion: AgentSessionTurnCompletion): string {
  return [agentSessionScopeKey(completion.scope), completion.sessionId, completion.turnId].join(
    '\u0000'
  )
}
