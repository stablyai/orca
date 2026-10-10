// A reply cut off because the Orca running the chat stopped (an update, a quit, a crash), as the
// host's row about it says, and whether the chat is still sitting on that cut. Derived from the
// journal each time, never stored: the client shows Continue from it, and the host re-checks it
// under the session lock before Continue sends anything.

import { readAgentSessionOrcaStop, type AgentSessionOrcaStopCause } from './agent-session-orca-stop'
import { isRootAgentJournalItem } from './agent-session-journal-producer'
import type { AgentJournalRenderItem, AgentJournalSubmission } from './agent-session-journal-types'
import { STALE_SESSION_ROW_PREFIX } from './agent-session-stop-row-identity'
import { readAgentJournalTurn, readAgentJournalTurnOutcome } from './agent-session-turn-record'
import { agentTurnVerdict } from './agent-turn-outcome'
import { structuredAgentSessionCommandTurnItemIds } from './structured-agent-session-command-entry'
import { isStructuredAgentSessionNonRequestRow } from './structured-agent-session-latest-request'

/** The row a quit or update writes for the turn it cut, keyed by the child the quit stopped, so a
 *  retried stop of that child writes no second row. The prefix is one older clients already read
 *  as explaining a cut turn, so they add no row of their own beside it. */
export function orcaShutdownRowClientMessageId(
  sessionId: string,
  fence: number,
  generation: string
): string {
  return `${STALE_SESSION_ROW_PREFIX}${sessionId}:shutdown-${fence}-${generation}`
}

/** Why Orca stopped, from a status row the host wrote about it; null for any other row. */
export function orcaStopCauseOfRow(item: AgentJournalRenderItem): AgentSessionOrcaStopCause | null {
  return item.body.kind === 'status'
    ? (readAgentSessionOrcaStop(item.body.orcaStop)?.cause ?? null)
    : null
}

export type NativeChatOrcaStopCut = {
  turnItemId: string
  cause: AgentSessionOrcaStopCause
}

/**
 * The latest root turn, when an Orca stop cut it and nothing was sent since: no request after it,
 * and no send still on its way. A steer into that turn or a conversation command asks for nothing
 * new (`isStructuredAgentSessionNonRequestRow`). Null otherwise.
 */
export function latestNativeChatOrcaStopCut(
  items: readonly AgentJournalRenderItem[],
  submissions: readonly Pick<AgentJournalSubmission, 'dispatchState'>[]
): NativeChatOrcaStopCut | null {
  if (submissions.some((submission) => submission.dispatchState === 'pending')) {
    return null
  }
  const commandTurns = structuredAgentSessionCommandTurnItemIds(items)
  let turnIndex = -1
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]!
    if (
      !isRootAgentJournalItem(item) ||
      isStructuredAgentSessionNonRequestRow(item, commandTurns)
    ) {
      continue
    }
    if (item.body.kind === 'message' && item.body.role === 'user') {
      return null
    }
    if (readAgentJournalTurn(item.body)) {
      turnIndex = index
      break
    }
  }
  const turnItem = items[turnIndex]
  const turn = turnItem ? readAgentJournalTurn(turnItem.body) : null
  if (
    !turnItem ||
    !turn ||
    agentTurnVerdict({ state: turn.state, outcome: readAgentJournalTurnOutcome(turn) }) !==
      'interruption'
  ) {
    return null
  }
  for (const item of items) {
    const cause =
      item.turnScope?.kind === 'turn' && item.turnScope.turnItemId === turnItem.itemId
        ? orcaStopCauseOfRow(item)
        : null
    if (cause) {
      return { turnItemId: turnItem.itemId, cause }
    }
  }
  return null
}
