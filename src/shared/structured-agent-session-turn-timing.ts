// Durable host-clock lifecycle endpoints/provider durations keep settled timing identical on desktop/mobile without client clocks.

import { agentJournalSubmissionKey } from './agent-session-journal-item-key'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission,
  AgentJournalTurnLifecycleState
} from './agent-session-journal-types'
import { readAgentJournalTurn, readAgentJournalTurnOutcome } from './agent-session-turn-record'
import { agentTurnVerdict, type AgentTurnOutcome } from './agent-turn-outcome'
import { structuredAgentTurnAnchors } from './native-chat-turn-membership'
import type { NativeChatSettledTurn, NativeChatSettledTurns } from './native-chat-turn-status'
import type { AgentSessionLatestTurn } from './agent-session-wire'

export type StructuredAgentTurnTiming = {
  state: AgentJournalTurnLifecycleState
  /** Host clock at provider turn-start receipt. */
  startedAt: number
  /** Opening send’s host clock; absent for resumed/history turns or older hosts. */
  requestedAt?: number
  /** Host clock at the terminal provider event; absent while running or unverifiable. */
  completedAt?: number
  /** The provider's own measurement; used when exact host endpoints are unavailable. */
  durationMs?: number
  /** Previous turn’s end for a send queued behind it; absent when it did not wait. */
  queuedUntil?: number
  /** Row append’s host clock; subtract start-to-append lag from the live anchor. */
  observedAt: number
  /** The turn's verdict, the provider's or the host-observed end's; absent when unknown. */
  verdict?: AgentTurnOutcome
}

function readTiming(
  item: Pick<AgentJournalRenderItem, 'body' | 'observedAt'>,
  precedingTurnEndedAt: number | undefined
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
  const verdict = agentTurnVerdict({ state, outcome: readAgentJournalTurnOutcome(turn) })
  // Exclude waiting behind the previous turn, using its end or last host revision, capped at this turn’s start.
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

/** One root-turn scan, indexed by provider ID and opener/self anchor (structuredAgentTurnAnchors).
 * Omit untimed anchor rows unless explicitly unverifiable (null). */
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
  let precedingTurnEndedAt: number | undefined
  for (const item of items) {
    const anchor = anchors.get(item.itemId)
    const turn = anchor === undefined ? null : readAgentJournalTurn(item.body)
    if (anchor === undefined || !turn) {
      continue
    }
    const timing = readTiming(item, precedingTurnEndedAt)
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

/** Null timing on older hosts without a host start lets surfaces fall back to local observation. */
export function selectStructuredAgentRunningTurnTiming(
  items: readonly AgentJournalRenderItem[],
  turnId: string
): StructuredAgentTurnTiming | null {
  return readStructuredAgentJournalTurns(items).byTurnId.get(turnId) ?? null
}

/** Shared live/settled origin: queuedUntil, else opening send, else provider start; excludes time waiting behind the prior turn. */
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

/** Convert elapsed host-only differences onto the client’s firstSeen clock to avoid skew. With hostNow, include pre-attach elapsed;
 * otherwise subtract only known start-to-append lag. Never subtract timestamps from different clocks. */
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
  // Clamp NTP-induced negative host elapsed so the counter cannot run backwards.
  return firstSeenAt - Math.max(0, hostElapsed)
}

/** Host null durations outrank local guesses, keeping live/reloaded surfaces consistent for unobserved ends.
 * Rejected sends opened no turn and therefore show no duration. */
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

/** Scan once for settled/running timings; nativeChatTurnMembership separately chooses the running bar. */
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
          undefined
        )
      : turnId === null
        ? null
        : (turns.byTurnId.get(turnId) ?? null)
  }
}
