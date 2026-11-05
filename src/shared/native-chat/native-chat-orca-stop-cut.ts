import {
  structuredAgentSessionCommandTurnItemIdsSteps,
  isStructuredAgentSessionCommandTurn
} from '../agent-session/structured-agent-session-command-entry'
import { finishAgentSessionSteps } from '../agent-session/agent-session-projection-steps'
// Derive Orca-stop cuts from the journal for Continue; never store them. Host rechecks under the session lock before sending.

import {
  readAgentSessionOrcaStop,
  type AgentSessionOrcaStopCause
} from '../agent-session/lifecycle/agent-session-orca-stop'
import { isRootAgentJournalItem } from '../agent-session/journal/agent-session-journal-producer'
import type {
  AgentJournalItemBody,
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../agent-session/journal/agent-session-journal-types'
import { STALE_SESSION_ROW_PREFIX } from '../agent-session/lifecycle/agent-session-stop-row-identity'
import {
  readAgentJournalTurn,
  readAgentJournalTurnOutcome
} from '../agent-session/lifecycle/agent-session-turn-record'
import {
  agentTurnVerdict,
  type AgentTurnOutcome
} from '../agent-status/lifecycle/agent-turn-outcome'
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
  bodyOf?: (itemId: string) => AgentJournalItemBody | null | undefined
): { turnItem: AgentJournalRenderItem; verdict: AgentTurnOutcome | null } | null {
  return finishAgentSessionSteps(latestNativeChatTurnSinceRequestSteps(items, submissions, bodyOf))
}

export function* latestNativeChatTurnSinceRequestSteps(
  items: readonly AgentJournalRenderItem[],
  submissions: readonly Pick<AgentJournalSubmission, 'dispatchState'>[],
  bodyOf?: (itemId: string) => AgentJournalItemBody | null | undefined
): Generator<void, { turnItem: AgentJournalRenderItem; verdict: AgentTurnOutcome | null } | null> {
  for (const submission of submissions) {
    yield
    if (submission.dispatchState === 'pending') {
      return null
    }
  }
  const commandTurns = bodyOf
    ? commandTurnsByBody(bodyOf)
    : yield* structuredAgentSessionCommandTurnItemIdsSteps(items)
  for (let index = items.length - 1; index >= 0; index -= 1) {
    yield

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
  return finishAgentSessionSteps(findInNativeChatTurnSteps(items, turnItemId, read))
}

export function* findInNativeChatTurnSteps<T>(
  items: readonly AgentJournalRenderItem[],
  turnItemId: string,
  read: (item: AgentJournalRenderItem) => T | null
): Generator<void, T | null> {
  for (const item of items) {
    yield

    const inTurn = item.turnScope?.kind === 'turn' && item.turnScope.turnItemId === turnItemId
    const found = inTurn ? read(item) : null
    if (found !== null) {
      return found
    }
  }
  return null
}

function commandTurnsByBody(
  bodyOf: (itemId: string) => AgentJournalItemBody | null | undefined
): Pick<ReadonlySet<string>, 'has'> {
  const known = new Map<string, boolean>()
  return {
    has: (itemId) => {
      let command = known.get(itemId)
      if (command === undefined) {
        command = isStructuredAgentSessionCommandTurn(
          readAgentJournalTurn(bodyOf(itemId) ?? undefined),
          bodyOf
        )
        known.set(itemId, command)
      }
      return command
    }
  }
}

export function latestNativeChatOrcaStopCut(
  items: readonly AgentJournalRenderItem[],
  submissions: readonly Pick<AgentJournalSubmission, 'dispatchState'>[]
): NativeChatOrcaStopCut | null {
  return finishAgentSessionSteps(latestNativeChatOrcaStopCutSteps(items, submissions))
}

export function* latestNativeChatOrcaStopCutSteps(
  items: readonly AgentJournalRenderItem[],
  submissions: readonly Pick<AgentJournalSubmission, 'dispatchState'>[]
): Generator<void, NativeChatOrcaStopCut | null> {
  const latest = yield* latestNativeChatTurnSinceRequestSteps(items, submissions)
  if (!latest || latest.verdict !== 'interruption') {
    return null
  }
  const turnItemId = latest.turnItem.itemId
  const cause = yield* findInNativeChatTurnSteps(items, turnItemId, orcaStopCauseOfRow)
  return cause ? { turnItemId, cause } : null
}

/** Intentional shutdown is cancellation in status; retain raw cut verdicts for Continue. */
export function nativeChatStatusTurnOutcome(
  request: StructuredAgentSessionLatestRequest | null,
  items: readonly AgentJournalRenderItem[],
  submissions: readonly Pick<AgentJournalSubmission, 'dispatchState'>[]
): AgentTurnOutcome | null {
  return finishAgentSessionSteps(nativeChatStatusTurnOutcomeSteps(request, items, submissions))
}

export function* nativeChatStatusTurnOutcomeSteps(
  request: StructuredAgentSessionLatestRequest | null,
  items: readonly AgentJournalRenderItem[],
  submissions: readonly Pick<AgentJournalSubmission, 'dispatchState'>[]
): Generator<void, AgentTurnOutcome | null> {
  const verdict = request
    ? agentTurnVerdict({ state: request.turnState, outcome: request.outcome })
    : null
  const stop =
    verdict === 'interruption' ? yield* latestNativeChatOrcaStopCutSteps(items, submissions) : null
  return stop && stop.cause !== 'crash' ? 'cancellation' : verdict
}
