// What a row already says about a root turn cut short with nobody asking. Read by the transcript's
// cut notice (an explained cut gets none) and by every reader of a turn's verdict (a cut the agent's
// own exit explains is that agent's failure), so the two always agree on the cause.

import { readAgentSessionFailureFact } from './agent-session-failure'
import { parseAgentJournalItemKey } from './agent-session-journal-item-key'
import { isRootAgentJournalItem } from './agent-session-journal-producer'
import type { AgentJournalRenderItem } from './agent-session-journal-types'
import { readAgentJournalTurn, readAgentJournalTurnOutcome } from './agent-session-turn-record'
import { agentTurnVerdict, type AgentTurnOutcome } from './agent-turn-outcome'
import {
  PROVIDER_EXIT_ROW_PREFIX,
  RESTART_CONTINUATION_ROW_PREFIX,
  STALE_SESSION_ROW_PREFIX
} from './agent-session-stop-row-identity'
import { isStructuredAgentSessionStartFailureRow } from './structured-agent-session-start-failure-row-key'

/** `exit`: the agent stopped on its own. `owner-death`: a reopen proved the old agent process gone,
 *  which is about the cut whatever was sent since. `not-continued`: a resume after a restart did not
 *  carry the chat on. */
export type CutTurnStopExplanation = 'exit' | 'owner-death' | 'not-continued'

function rootTurnVerdict(item: AgentJournalRenderItem): AgentTurnOutcome | null | 'none' {
  const turn = readAgentJournalTurn(item.body)
  return turn && isRootAgentJournalItem(item)
    ? agentTurnVerdict({ state: turn.state, outcome: readAgentJournalTurnOutcome(turn) })
    : 'none'
}

/** Root turns that ended interrupted with no verdict, so nobody asked for the stop. */
export function isCutRootTurn(item: AgentJournalRenderItem): boolean {
  return rootTurnVerdict(item) === 'interruption'
}

/** What a row says about a stop, matched by what it states or who wrote it, never its tone alone:
 *  an agent's own error row in the turn (a denied permission, a refusal) says nothing about the stop.
 *  A restart note marks a continuation that did not go on with a tone ('error' refused or not
 *  connected, 'warning' unconfirmed); one that went on has none. A failed start's row is about a
 *  start. */
export function cutTurnStopExplanation(
  item: AgentJournalRenderItem
): CutTurnStopExplanation | null {
  if (
    item.body.kind !== 'status' ||
    readAgentJournalTurn(item.body) ||
    isStructuredAgentSessionStartFailureRow(item.itemId)
  ) {
    return null
  }
  const identity = parseAgentJournalItemKey(item.itemId)
  const clientMessageId = identity?.provider === 'orca' ? identity.clientMessageId : ''
  if (clientMessageId.startsWith(STALE_SESSION_ROW_PREFIX)) {
    return 'owner-death'
  }
  if (
    readAgentSessionFailureFact(item.body.failure)?.kind === 'providerExited' ||
    clientMessageId.startsWith(PROVIDER_EXIT_ROW_PREFIX)
  ) {
    return 'exit'
  }
  const { tone } = item.body
  return clientMessageId.startsWith(RESTART_CONTINUATION_ROW_PREFIX) &&
    (tone === 'error' || tone === 'warning')
    ? 'not-continued'
    : null
}

/**
 * The cut turns some row already explains, and how: one scoped to the turn, or one about the
 * conversation (or from a host that states no scope) that follows the cut turn closely enough to be
 * about it. An exit row is about the cut only with no message sent since, which a later start would
 * be answering. An owner's proven death, and a restart note that follows the continuation's own
 * message, are about the cut until another turn begins. The agent's own exit outranks any other
 * explanation of the same turn: it is the one row that names a cause.
 */
export function explainedCutTurns(
  items: readonly AgentJournalRenderItem[]
): ReadonlyMap<string, CutTurnStopExplanation> {
  const explained = new Map<string, CutTurnStopExplanation>()
  let cutNoSendSince: string | null = null
  let cutNoTurnSince: string | null = null
  for (const item of items) {
    const verdict = rootTurnVerdict(item)
    if (verdict !== 'none') {
      cutNoSendSince = cutNoTurnSince = verdict === 'interruption' ? item.itemId : null
      continue
    }
    if (item.body.kind === 'message' && item.body.role === 'user' && isRootAgentJournalItem(item)) {
      cutNoSendSince = null
      continue
    }
    const explanation = cutTurnStopExplanation(item)
    if (explanation === null) {
      continue
    }
    const scope = item.turnScope
    const turnItemId =
      scope?.kind === 'turn'
        ? scope.turnItemId
        : explanation === 'exit'
          ? cutNoSendSince
          : cutNoTurnSince
    if (turnItemId !== null && explained.get(turnItemId) !== 'exit') {
      explained.set(turnItemId, explanation)
    }
  }
  return explained
}

/**
 * Reads each turn's verdict as every surface shows it: the turn record's, except that a cut the
 * agent's own exit explains is that agent's failure, as its red exit row says. Derived, never
 * stored, so old and new journals read alike and no completion event is announced for it. An exit
 * whose settle failed is written later by the reopen as an owner's death, whose evidence cannot tell
 * the agent's own exit from a quit's close, so that one stays a plain interruption.
 */
export function structuredAgentTurnVerdictReader(
  items: readonly AgentJournalRenderItem[]
): (item: AgentJournalRenderItem) => AgentTurnOutcome | null {
  let explained: ReadonlyMap<string, CutTurnStopExplanation> | undefined
  return (item) => {
    const turn = readAgentJournalTurn(item.body)
    const verdict =
      turn && agentTurnVerdict({ state: turn.state, outcome: readAgentJournalTurnOutcome(turn) })
    if (verdict !== 'interruption' || !isRootAgentJournalItem(item)) {
      return verdict ?? null
    }
    explained ??= explainedCutTurns(items)
    return explained.get(item.itemId) === 'exit' ? 'failure' : verdict
  }
}
