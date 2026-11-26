import type { AgentSessionContextUsage } from '../../conversation-context/agent-session-context-usage'
import type { AgentSessionTurnTokenAccounting } from '../../conversation-context/agent-session-turn-token-accounting'
import type { AgentJournalTurnOutcome } from '../../../agent-status/lifecycle/agent-turn-outcome'

export const AGENT_JOURNAL_TURN_LIFECYCLE_STATES = [
  'running',
  'completed',
  'interrupted',
  'unverifiable'
] as const
export type AgentJournalTurnLifecycleState = (typeof AGENT_JOURNAL_TURN_LIFECYCLE_STATES)[number]

export type AgentJournalTurnLifecycle = {
  tokenAccounting?: AgentSessionTurnTokenAccounting
  turnId: string
  state: AgentJournalTurnLifecycleState
  /** Absent/unrecognized verdict means unknown, never success. completed alone proves nothing: provider API errors also finish turns. */
  outcome?: AgentJournalTurnOutcome
  /** Journal key of the user item that opened the turn. A lifecycle row may key
   *  itself when provider output opened a turn with no user item; absent means
   *  an older host. */
  userItemId?: string
  startedAt?: number
  /** Host clock at the send that opened this turn, when one is known. `startedAt`
   *  remains the provider turn-open instant and is never rewritten. */
  requestedAt?: number
  completedAt?: number
  /** The provider's own measured turn duration, preferred over the host interval. */
  durationMs?: number
  /** What the provider said about its context window during or after this turn.
   *  Usually written by a later revision, since the provider answers after the end. */
  contextUsage?: AgentSessionContextUsage
  /** On a turn a conversation command opened: the provider turn that carried out the command,
   *  once the provider opened one. Nothing else re-derives it after the command settles. */
  providerTurnId?: string
}
