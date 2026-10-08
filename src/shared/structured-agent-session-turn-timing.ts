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
import type { AgentTurnOutcome } from './agent-turn-outcome'
import { structuredAgentTurnVerdictReader } from './native-chat-cut-turn-explanation'
import { structuredAgentTurnAnchors } from './native-chat-turn-membership'
import type { NativeChatSettledTurn, NativeChatSettledTurns } from './native-chat-turn-status'
import type { AgentSessionLatestTurn } from './agent-session-wire'

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
  /** Host clock this turn's send stopped waiting behind the journal's previous
   *  turn; present only when the send was issued before that turn ended. */
  queuedUntil?: number
  /** Host clock when the lifecycle row was appended; with `startedAt` it gives
   *  the host-side lag a client must subtract to anchor a live counter. */
  observedAt: number
  /** The turn's verdict as every surface reads it (`structuredAgentTurnVerdictReader`); absent when
   *  unknown. */
  verdict?: AgentTurnOutcome
}

function readTiming(
  item: Pick<AgentJournalRenderItem, 'body' | 'observedAt'>,
  precedingTurnEndedAt: number | undefined,
  /** The turn's verdict as every surface reads it (`structuredAgentTurnVerdictReader`). */
  verdict: AgentTurnOutcome | null
): StructuredAgentTurnTiming | null {
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
  // A send queued behind the previous turn counts from that turn's end (recorded, else its row's
  // last host revision), never past this turn's own start: the provider opens it only after.
  const queuedUntil =
    precedingTurnEndedAt === undefined ? undefined : Math.min(precedingTurnEndedAt, startedAt)
  return {
    state,
    startedAt,
    ...(requested !== undefined ? { requestedAt: requested } : {}),
    ...(end !== undefined ? { completedAt: end } : {}),
    ...(measured !== undefined ? { durationMs: measured } : {}),
    ...(requested !== undefined && queuedUntil !== undefined && queuedUntil > requested
      ? { queuedUntil }
      : {}),
    observedAt: item.observedAt,
    ...(verdict ? { verdict } : {})
  }
}

/** Every root turn record in one pass over the journal, keyed by its anchor (see
 *  `structuredAgentTurnAnchors`: the user message that opened it, or the record itself for a turn
 *  no message opened) and by provider turn id. Untimed rows are skipped from the anchor map unless
 *  explicitly unverifiable (null). */
type StructuredAgentJournalTurns = {
  byAnchor: ReadonlyMap<string, StructuredAgentTurnTiming | null>
  byTurnId: ReadonlyMap<string, StructuredAgentTurnTiming | null>
}

function readStructuredAgentJournalTurns(
  items: readonly AgentJournalRenderItem[],
  submissions: readonly AgentJournalSubmission[] = []
): StructuredAgentJournalTurns {
  const anchors = structuredAgentTurnAnchors(items, submissions)
  const byAnchor = new Map<string, StructuredAgentTurnTiming | null>()
  const byTurnId = new Map<string, StructuredAgentTurnTiming | null>()
  const verdictOf = structuredAgentTurnVerdictReader(items)
  let precedingTurnEndedAt: number | undefined
  for (const item of items) {
    const anchor = anchors.get(item.itemId)
    const turn = anchor === undefined ? null : readAgentJournalTurn(item.body)
    if (anchor === undefined || !turn) {
      continue
    }
    const timing = readTiming(item, precedingTurnEndedAt, verdictOf(item))
    precedingTurnEndedAt = timing?.completedAt ?? item.observedAt
    byTurnId.set(turn.turnId, timing)
    if (timing || turn.state === 'unverifiable') {
      byAnchor.set(anchor, timing)
    }
  }
  return { byAnchor, byTurnId }
}

export function selectStructuredAgentTurnTimings(
  items: readonly AgentJournalRenderItem[],
  submissions: readonly AgentJournalSubmission[] = []
): ReadonlyMap<string, StructuredAgentTurnTiming | null> {
  return readStructuredAgentJournalTurns(items, submissions).byAnchor
}

/** The live turn's lifecycle timing, or null when its row carries no host start
 *  (an older host), in which case a surface falls back to local observation. */
export function selectStructuredAgentRunningTurnTiming(
  items: readonly AgentJournalRenderItem[],
  turnId: string
): StructuredAgentTurnTiming | null {
  return readStructuredAgentJournalTurns(items).byTurnId.get(turnId) ?? null
}

/** The single instant every reading of a turn's elapsed time counts from: the
 *  send that opened it when the host named one — or, for a send queued behind the
 *  previous turn, that turn's end — and the provider turn-open otherwise.
 *  One origin is what keeps the live counter and the settled duration agreeing. */
export function structuredAgentTurnOrigin(timing: StructuredAgentTurnTiming): number {
  return timing.queuedUntil ?? timing.requestedAt ?? timing.startedAt
}

/** Whole seconds a settled turn ran, or null when the host never observed its end. */
export function completedStructuredAgentTurnSeconds(
  timing: StructuredAgentTurnTiming | null | undefined
): number | null {
  if (!timing || (timing.state !== 'completed' && timing.state !== 'interrupted')) {
    return null
  }
  // Provider durations may begin before the live origin (turn-open, or a turn this send queued behind).
  if (timing.requestedAt !== undefined && timing.completedAt !== undefined) {
    return Math.max(0, Math.floor((timing.completedAt - structuredAgentTurnOrigin(timing)) / 1000))
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
  return settledTurnsOf(readStructuredAgentJournalTurns(items, submissions), submissions)
}

function settledTurnsOf(
  turns: StructuredAgentJournalTurns,
  submissions: readonly AgentJournalSubmission[]
): NativeChatSettledTurns {
  const settled = new Map<string, NativeChatSettledTurn | null>()
  for (const [userItemId, timing] of turns.byAnchor) {
    const workedSeconds = completedStructuredAgentTurnSeconds(timing)
    settled.set(
      userItemId,
      workedSeconds === null || timing === null
        ? null
        : {
            startedAt: timing.startedAt,
            workedSeconds,
            ...(timing.verdict ? { verdict: timing.verdict } : {})
          }
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

/** Everything a chat surface reads off the journal for its turn bars, from one
 *  pass: settled durations and the running turn's timing. Which bar carries the
 *  running clock is the turn membership's answer (`nativeChatTurnMembership`). */
export function selectStructuredAgentTurnBars(
  items: readonly AgentJournalRenderItem[],
  submissions: readonly AgentJournalSubmission[],
  turnId: string | null,
  /** The host's newest turn record, which times a running turn whose row is not loaded. */
  latestTurn?: AgentSessionLatestTurn | null
): {
  settledTurns: NativeChatSettledTurns
  runningTiming: StructuredAgentTurnTiming | null
} {
  const turns = readStructuredAgentJournalTurns(items, submissions)
  const unloaded =
    turnId !== null && !turns.byTurnId.has(turnId) && latestTurn?.turn.turnId === turnId
      ? latestTurn
      : null
  return {
    settledTurns: settledTurnsOf(turns, submissions),
    runningTiming: unloaded
      ? readTiming(
          { body: { kind: 'turn', ...unloaded.turn }, observedAt: unloaded.observedAt },
          undefined,
          // Running: it has no verdict yet.
          null
        )
      : turnId === null
        ? null
        : (turns.byTurnId.get(turnId) ?? null)
  }
}
