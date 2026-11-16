// Derive Orca-stop cuts from the journal for Continue; never store them. Host rechecks under the session lock before sending.

import {
  readAgentSessionOrcaStop,
  type AgentSessionOrcaStopCause
} from '../agent-session/lifecycle/stopping/agent-session-orca-stop'
import { isRootAgentJournalItem } from '../agent-session/journal/agent-session-journal-producer'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../agent-session/journal/agent-session-journal-types'
import { STALE_SESSION_ROW_PREFIX } from '../agent-session/lifecycle/stopping/agent-session-stop-row-identity'
import {
  readAgentJournalTurn,
  readAgentJournalTurnOutcome
} from '../agent-session/lifecycle/records/agent-session-turn-record'
import {
  agentTurnVerdict,
  type AgentTurnOutcome
} from '../agent-status/lifecycle/agent-turn-outcome'
import {
  commandTurnsOf,
  type AgentJournalBodyLookup
} from '../agent-session/structured-agent-session-command-entry'
import {
  isStructuredAgentSessionNonRequestRow,
  type StructuredAgentSessionLatestRequest
} from '../agent-session/requests/structured-agent-session-latest-request'

// Dedupe shutdown rows by stopped child; preserve the legacy prefix so older clients add no duplicate notice.
export function orcaShutdownRowClientMessageId(
  sessionId: string,
  fence: number,
  generation: string
): string {
  return `${STALE_SESSION_ROW_PREFIX}${sessionId}:shutdown-${fence}-${generation}`
}

export function orcaStopCauseOfRow(item: AgentJournalRenderItem): AgentSessionOrcaStopCause | null {
  return item.body.kind === 'status'
    ? (readAgentSessionOrcaStop(item.body.orcaStop)?.cause ?? null)
    : null
}

export type NativeChatOrcaStopCut = {
  turnItemId: string
  cause: AgentSessionOrcaStopCause
}

/** Latest root turn only if no later request or in-flight send exists; steers/conversation commands do not count as new requests. */
export function latestNativeChatTurnSinceRequest(
  items: readonly AgentJournalRenderItem[],
  submissions: readonly Pick<AgentJournalSubmission, 'dispatchState'>[],
  /** With an indexed body read, only the turns this scan reaches are checked, not all history. */
  bodyOf?: AgentJournalBodyLookup
): { turnItem: AgentJournalRenderItem; verdict: AgentTurnOutcome | null } | null {
  if (submissions.some((submission) => submission.dispatchState === 'pending')) {
    return null
  }
  const commandTurns = commandTurnsOf(items, bodyOf)
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

export function latestNativeChatOrcaStopCut(
  items: readonly AgentJournalRenderItem[],
  submissions: readonly Pick<AgentJournalSubmission, 'dispatchState'>[],
  bodyOf?: AgentJournalBodyLookup
): NativeChatOrcaStopCut | null {
  const latest = latestNativeChatTurnSinceRequest(items, submissions, bodyOf)
  if (!latest || latest.verdict !== 'interruption') {
    return null
  }
  const turnItemId = latest.turnItem.itemId
  const cause = findInNativeChatTurn(items, turnItemId, orcaStopCauseOfRow)
  return cause ? { turnItemId, cause } : null
}

/** Intentional shutdown is cancellation in status; retain raw cut verdicts for Continue. */
export function nativeChatStatusTurnOutcome(
  request: StructuredAgentSessionLatestRequest | null,
  items: readonly AgentJournalRenderItem[],
  submissions: readonly Pick<AgentJournalSubmission, 'dispatchState'>[],
  bodyOf?: AgentJournalBodyLookup
): AgentTurnOutcome | null {
  const verdict = request
    ? agentTurnVerdict({ state: request.turnState, outcome: request.outcome })
    : null
  const stop =
    verdict === 'interruption' ? latestNativeChatOrcaStopCut(items, submissions, bodyOf) : null
  return nativeChatStatusRequestOutcome(request, stop)
}

/** Named database readers supply the same selected cut without rendering the chat. */
export function nativeChatStatusRequestOutcome(
  request: StructuredAgentSessionLatestRequest | null,
  stop: NativeChatOrcaStopCut | null
): AgentTurnOutcome | null {
  const verdict = request
    ? agentTurnVerdict({ state: request.turnState, outcome: request.outcome })
    : null
  return verdict === 'interruption' && stop && stop.cause !== 'crash' ? 'cancellation' : verdict
}
