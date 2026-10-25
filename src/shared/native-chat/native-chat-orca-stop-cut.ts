// A reply cut off because the Orca running the chat stopped (an update, a quit, a crash), as the
// host's row about it says, and whether the chat is still sitting on that cut. Derived from the
// journal each time, never stored: the client shows Continue from it, and the host re-checks it
// under the session lock before Continue sends anything.

import {
  readAgentSessionOrcaStop,
  type AgentSessionOrcaStopCause
} from '../agent-session-orca-stop'
import { isRootAgentJournalItem } from '../agent-session-journal-producer'
import type { AgentJournalRenderItem, AgentJournalSubmission } from '../agent-session-journal-types'
import { STALE_SESSION_ROW_PREFIX } from '../agent-session-stop-row-identity'
import { readAgentJournalTurn, readAgentJournalTurnOutcome } from '../agent-session-turn-record'
import { agentTurnVerdict, type AgentTurnOutcome } from '../agent-turn-outcome'
import { structuredAgentSessionCommandTurnItemIds } from '../structured-agent-session-command-entry'
import { isStructuredAgentSessionNonRequestRow } from '../structured-agent-session-latest-request'

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
 * The latest root turn, when nothing was sent since: no request after it, and no send still on its
 * way. A steer into that turn or a conversation command asks for nothing new
 * (`isStructuredAgentSessionNonRequestRow`). Null otherwise.
 */
export function latestNativeChatTurnSinceRequest(
  items: readonly AgentJournalRenderItem[],
  submissions: readonly Pick<AgentJournalSubmission, 'dispatchState'>[]
): { turnItem: AgentJournalRenderItem; verdict: AgentTurnOutcome | null } | null {
  if (submissions.some((submission) => submission.dispatchState === 'pending')) {
    return null
  }
  const commandTurns = structuredAgentSessionCommandTurnItemIds(items)
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
    const turn = readAgentJournalTurn(item.body)
    if (turn) {
      return {
        turnItem: item,
        verdict: agentTurnVerdict({ state: turn.state, outcome: readAgentJournalTurnOutcome(turn) })
      }
    }
  }
  return null
}

/** The rows inside one turn that answer `read`, first match wins. */
export function findInNativeChatTurn<T>(
  items: readonly AgentJournalRenderItem[],
  turnItemId: string,
  read: (item: AgentJournalRenderItem) => T | null
): T | null {
  for (const item of items) {
    const inTurn = item.turnScope?.kind === 'turn' && item.turnScope.turnItemId === turnItemId
    const found = inTurn ? read(item) : null
    if (found !== null) {
      return found
    }
  }
  return null
}

/** The latest root turn, when an Orca stop cut it and nothing was sent since. Null otherwise. */
export function latestNativeChatOrcaStopCut(
  items: readonly AgentJournalRenderItem[],
  submissions: readonly Pick<AgentJournalSubmission, 'dispatchState'>[]
): NativeChatOrcaStopCut | null {
  const latest = latestNativeChatTurnSinceRequest(items, submissions)
  if (!latest || latest.verdict !== 'interruption') {
    return null
  }
  const turnItemId = latest.turnItem.itemId
  const cause = findInNativeChatTurn(items, turnItemId, orcaStopCauseOfRow)
  return cause ? { turnItemId, cause } : null
}
