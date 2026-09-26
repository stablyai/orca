// Turn timing read straight off durable lifecycle items. The execution host
// stamps both endpoints on its own clock and records the provider's own
// measured duration when it reports one, so a completed value is the same on
// every client and needs no local clock. Shared by desktop and mobile.

import { agentJournalSubmissionKey } from './agent-session-journal-item-key'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission,
  AgentJournalTurnLifecycleState
} from './agent-session-journal-types'
import { readAgentJournalTurn } from './agent-session-turn-record'
import { structuredAgentTurnAnchors } from './native-chat-turn-membership'
import type { NativeChatSettledTurn, NativeChatSettledTurns } from './native-chat-turn-status'

export type StructuredAgentTurnTiming = {
  state: AgentJournalTurnLifecycleState
  /** Host clock at provider turn-start receipt. */
  startedAt: number
  /** Host clock at the send that opened the turn; absent when the host could not
   *  name one (provider-resumed turns, replayed history, older hosts). */
  requestedAt?: number
  /** Host clock at the terminal provider event; absent while running or unverifiable. */
  completedAt?: number
  /** The provider's own measurement; used when exact host endpoints are unavailable. */
  durationMs?: number
  /** Host clock when the lifecycle row was appended; with `startedAt` it gives
   *  the host-side lag a client must subtract to anchor a live counter. */
  observedAt: number
}

function readTiming(item: AgentJournalRenderItem): StructuredAgentTurnTiming | null {
  const turn = readAgentJournalTurn(item.body)
  if (!turn) {
    return null
  }
  const { state, startedAt, requestedAt, completedAt, durationMs } = turn
  if (startedAt === undefined || !Number.isFinite(startedAt) || startedAt <= 0) {
    return null
  }
  const requested =
    requestedAt !== undefined && Number.isFinite(requestedAt) && requestedAt > 0
      ? requestedAt
      : undefined
  const end =
    completedAt !== undefined && Number.isFinite(completedAt) && completedAt >= startedAt
      ? completedAt
      : undefined
  const measured =
    durationMs !== undefined && Number.isFinite(durationMs) && durationMs >= 0
      ? durationMs
      : undefined
  return {
    state,
    startedAt,
    ...(requested !== undefined ? { requestedAt: requested } : {}),
    ...(end !== undefined ? { completedAt: end } : {}),
    ...(measured !== undefined ? { durationMs: measured } : {}),
    observedAt: item.observedAt
  }
}

/** Timing keyed by each turn's anchor (see `structuredAgentTurnAnchors`): the user message that
 *  opened it, or the turn record itself for a turn no message opened. Untimed rows are skipped
 *  unless explicitly unverifiable (null). */
export function selectStructuredAgentTurnTimings(
  items: readonly AgentJournalRenderItem[],
  submissions: readonly AgentJournalSubmission[] = []
): ReadonlyMap<string, StructuredAgentTurnTiming | null> {
  const anchors = structuredAgentTurnAnchors(items, submissions)
  const timings = new Map<string, StructuredAgentTurnTiming | null>()
  for (const item of items) {
    const anchor = anchors.get(item.itemId)
    const timing = readTiming(item)
    if (
      anchor !== undefined &&
      (timing || readAgentJournalTurn(item.body)?.state === 'unverifiable')
    ) {
      timings.set(anchor, timing)
    }
  }
  return timings
}

/** The live turn's lifecycle timing, or null when its row carries no host start
 *  (an older host), in which case a surface falls back to local observation. */
export function selectStructuredAgentRunningTurnTiming(
  items: readonly AgentJournalRenderItem[],
  turnId: string
): StructuredAgentTurnTiming | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    if (item && readAgentJournalTurn(item.body)?.turnId === turnId) {
      return readTiming(item)
    }
  }
  return null
}

/** The single instant every reading of a turn's elapsed time counts from: the
 *  send that opened it when the host named one, the provider turn-open otherwise.
 *  One origin is what keeps the live counter and the settled duration agreeing. */
export function structuredAgentTurnOrigin(timing: StructuredAgentTurnTiming): number {
  return timing.requestedAt ?? timing.startedAt
}

/** Whole seconds a settled turn ran, or null when the host never observed its end. */
export function completedStructuredAgentTurnSeconds(
  timing: StructuredAgentTurnTiming | null | undefined
): number | null {
  if (!timing || (timing.state !== 'completed' && timing.state !== 'interrupted')) {
    return null
  }
  // Provider durations may begin at turn-open, so exact host endpoints preserve the live origin.
  if (timing.requestedAt !== undefined && timing.completedAt !== undefined) {
    return Math.max(0, Math.floor((timing.completedAt - timing.requestedAt) / 1000))
  }
  if (timing.durationMs !== undefined) {
    return Math.floor(timing.durationMs / 1000)
  }
  return timing.completedAt !== undefined
    ? Math.max(0, Math.floor((timing.completedAt - structuredAgentTurnOrigin(timing)) / 1000))
    : null
}

/** A local-clock anchor for the live counter that carries no host/client skew.
 *  With the host's own clock at publish time, the anchor is the client's first
 *  sighting moved back by how long the host says the turn has already run, so a
 *  client attaching mid-turn counts from the real start. Without it, only the
 *  host-side lag between turn-start receipt and the row's append is known, and
 *  the counter starts at first sight. Every difference is single-clock. */
export function structuredAgentTurnLocalStartedAt(
  timing: StructuredAgentTurnTiming,
  firstSeenAt: number,
  hostNow?: number
): number {
  const origin = structuredAgentTurnOrigin(timing)
  const hostElapsed =
    hostNow !== undefined && Number.isFinite(hostNow)
      ? hostNow - origin
      : timing.observedAt - origin
  // Wall-clock, not monotonic: an NTP step can put the origin after the host's
  // own reading, and a negative elapsed would run the counter backwards.
  return firstSeenAt - Math.max(0, hostElapsed)
}

/** What a chat surface hands to the shared turn-status selector: every turn the
 *  host recorded, with its duration or null. A null still outranks the local
 *  clock, so a turn whose end the host never observed shows no duration on the
 *  surface that watched it, exactly as it will after a reload. A rejected send
 *  never reached the provider, so it opened no turn and its message shows none. */
export function selectStructuredAgentSettledTurns(
  items: readonly AgentJournalRenderItem[],
  submissions: readonly AgentJournalSubmission[] = []
): NativeChatSettledTurns {
  const settled = new Map<string, NativeChatSettledTurn | null>()
  for (const [userItemId, timing] of selectStructuredAgentTurnTimings(items, submissions)) {
    const workedSeconds = completedStructuredAgentTurnSeconds(timing)
    settled.set(
      userItemId,
      workedSeconds === null || timing === null
        ? null
        : { startedAt: timing.startedAt, workedSeconds }
    )
  }
  for (const submission of submissions) {
    const userItemId = agentJournalSubmissionKey(submission.clientMessageId)
    if (submission.dispatchState === 'rejected' && !settled.has(userItemId)) {
      settled.set(userItemId, null)
    }
  }
  return settled
}
