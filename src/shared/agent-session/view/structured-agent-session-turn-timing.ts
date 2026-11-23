// Durable host-clock lifecycle endpoints/provider durations keep settled timing identical on desktop/mobile without client clocks.

import { agentJournalSubmissionKey } from '../journal/agent-session-journal-item-key'
import { agentJournalSubmissionAwaitsAgent } from '../requests/agent-session-queued-submission'
import { structuredAgentSessionOpeningSendIn } from '../requests/structured-agent-session-opening-send'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission,
  AgentJournalTurnLifecycleState
} from '../journal/agent-session-journal-types'
import {
  readAgentJournalTurn,
  readAgentJournalTurnOutcome
} from '../lifecycle/records/agent-session-turn-record'
import {
  agentTurnVerdict,
  type AgentTurnOutcome
} from '../../agent-status/lifecycle/agent-turn-outcome'
import { structuredAgentTurnAnchors } from '../../native-chat/transcript/turns/native-chat-turn-membership'
import type {
  NativeChatSettledTurn,
  NativeChatSettledTurns
} from '../../native-chat/transcript/turns/native-chat-turn-status'
import type { AgentSessionLatestTurn } from '../agent-session-wire'

export type StructuredAgentTurnTiming = {
  state: AgentJournalTurnLifecycleState
  /** Host clock at provider turn-start receipt. */
  startedAt: number
  /** Opening send’s host clock; absent for resumed/history turns or older hosts. */
  requestedAt?: number
  /** When the idle agent took the opening send's write, so "Sending…" cleared; absent otherwise. */
  writtenAt?: number
  /** Host clock at the terminal provider event; absent while running or unverifiable. */
  completedAt?: number
  /** The provider's own measurement; used when exact host endpoints are unavailable. */
  durationMs?: number
  /** Row append’s host clock; subtract start-to-append lag from the live anchor. */
  observedAt: number
  /** The turn's verdict, the provider's or the host-observed end's; absent when unknown. */
  verdict?: AgentTurnOutcome
}

function readTiming(
  item: Pick<AgentJournalRenderItem, 'body' | 'observedAt'>,
  /** The opening send's own stamp, for a record written before the host copied it. */
  sendWrittenAt?: number
): StructuredAgentTurnTiming | null {
  const turn = readAgentJournalTurn(item.body)
  if (!turn) {
    return null
  }
  const writtenAt =
    turn.writtenAt !== undefined && Number.isFinite(turn.writtenAt) && turn.writtenAt > 0
      ? turn.writtenAt
      : sendWrittenAt
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
  return {
    state,
    startedAt,
    ...(requested !== undefined ? { requestedAt: requested } : {}),
    ...(end !== undefined ? { completedAt: end } : {}),
    ...(measured !== undefined ? { durationMs: measured } : {}),
    // A stamp saved just after a fast echo never moves the origin past the provider's start.
    ...(writtenAt !== undefined ? { writtenAt: Math.min(writtenAt, startedAt) } : {}),
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
  const written = writtenSends(submissions)
  const byAnchor = new Map<string, StructuredAgentTurnTiming | null>()
  const byTurnId = new Map<string, StructuredAgentTurnTiming | null>()
  for (const item of items) {
    const anchor = anchors.get(item.itemId)
    const turn = anchor === undefined ? null : readAgentJournalTurn(item.body)
    if (anchor === undefined || !turn) {
      continue
    }
    const timing = readTiming(item, written.get(anchor))
    byTurnId.set(turn.turnId, timing)
    if (timing || turn.state === 'unverifiable') {
      byAnchor.set(anchor, timing)
    }
  }
  return { byAnchor, byTurnId }
}

// Streaming frames keep the submissions array, so its stamp index is built once per array.
const writtenSendsBySubmissions = new WeakMap<
  readonly AgentJournalSubmission[],
  ReadonlyMap<string, number>
>()

/** Each stamped send's writtenAt by its own key and its provider alias, which a turn may name instead. */
function writtenSends(submissions: readonly AgentJournalSubmission[]): ReadonlyMap<string, number> {
  const cached = writtenSendsBySubmissions.get(submissions)
  if (cached) {
    return cached
  }
  const written = new Map<string, number>()
  for (const submission of submissions) {
    if (submission.writtenAt !== undefined) {
      written.set(agentJournalSubmissionKey(submission.clientMessageId), submission.writtenAt)
      if (submission.providerItemId) {
        written.set(submission.providerItemId, submission.writtenAt)
      }
    }
  }
  writtenSendsBySubmissions.set(submissions, written)
  return written
}

const pendingWrittenSendsBySubmissions = new WeakMap<
  readonly AgentJournalSubmission[],
  ReadonlyMap<string, number>
>()

/** Stamped sends still awaiting their echo, by key: one may be opening a turn with no record yet. */
function pendingWrittenSends(
  submissions: readonly AgentJournalSubmission[]
): ReadonlyMap<string, number> {
  const cached = pendingWrittenSendsBySubmissions.get(submissions)
  if (cached) {
    return cached
  }
  const pending = new Map<string, number>()
  for (const submission of submissions) {
    const writtenAt = submission.writtenAt
    if (
      submission.dispatchState === 'pending' &&
      writtenAt !== undefined &&
      Number.isFinite(writtenAt) &&
      writtenAt > 0
    ) {
      pending.set(agentJournalSubmissionKey(submission.clientMessageId), writtenAt)
    }
  }
  pendingWrittenSendsBySubmissions.set(submissions, pending)
  return pending
}

/** The send opening the live turn, timed from its stamp so a viewer arriving before the turn record sees the real elapsed time. */
function writtenOpeningSend(
  items: readonly AgentJournalRenderItem[],
  submissions: readonly AgentJournalSubmission[]
): { key: string; timing: StructuredAgentTurnTiming } | null {
  const written = pendingWrittenSends(submissions)
  // The transcript scan runs only while some send is stamped and unechoed.
  const key = written.size > 0 ? structuredAgentSessionOpeningSendIn(items, submissions) : null
  const writtenAt = key === null ? undefined : written.get(key)
  return key === null || writtenAt === undefined
    ? null
    : { key, timing: { state: 'running', startedAt: writtenAt, writtenAt, observedAt: writtenAt } }
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

/** The turn's opening send has not reached the agent yet, so its clock has not started. */
export function structuredAgentTurnOpeningSendPending(
  turnKey: string | undefined,
  submissions: readonly AgentJournalSubmission[] = []
): boolean {
  return (
    turnKey !== undefined &&
    submissions.some(
      (submission) =>
        agentJournalSubmissionAwaitsAgent(submission) &&
        agentJournalSubmissionKey(submission.clientMessageId) === turnKey
    )
  )
}

/** Shared live/settled origin: when "Sending…" cleared, the write to the idle agent or else the provider's start. */
function structuredAgentTurnOrigin(timing: StructuredAgentTurnTiming): number {
  return timing.writtenAt ?? timing.startedAt
}

/** Whole seconds a settled turn ran, or null when the host never observed its end. */
export function completedStructuredAgentTurnSeconds(
  timing: StructuredAgentTurnTiming | null | undefined
): number | null {
  if (!timing || (timing.state !== 'completed' && timing.state !== 'interrupted')) {
    return null
  }
  // A host-sent turn uses the live clock's own interval, so "Worked for" matches what it counted.
  if (timing.requestedAt !== undefined && timing.completedAt !== undefined) {
    return Math.max(0, Math.floor((timing.completedAt - structuredAgentTurnOrigin(timing)) / 1000))
  }
  if (timing.durationMs !== undefined) {
    // Claude's own measure already includes the model's wait.
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
  const hostElapsed =
    hostNow !== undefined && Number.isFinite(hostNow)
      ? hostNow - structuredAgentTurnOrigin(timing)
      : timing.observedAt - structuredAgentTurnOrigin(timing)
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
    // A written send that died unconfirmed opened no turn, so it shows no local duration either.
    const unconfirmedWritten =
      submission.dispatchState === 'unknown' && submission.writtenAt !== undefined
    if (
      (submission.dispatchState === 'rejected' || unconfirmedWritten) &&
      !settled.has(userItemId)
    ) {
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
  /** The running turn's id, or the written opening send's key before its turn record exists. */
  runningKey: string | null
} {
  const turns = readStructuredAgentJournalTurns(items, submissions)
  if (turnId === null) {
    const opening = writtenOpeningSend(items, submissions)
    return {
      settledTurns: settledTurnsOf(turns, submissions),
      runningTiming: opening?.timing ?? null,
      runningKey: opening?.key ?? null
    }
  }
  const unloaded =
    turnId !== null && !turns.byTurnId.has(turnId) && latestTurn?.turn.turnId === turnId
      ? latestTurn
      : null
  return {
    settledTurns: settledTurnsOf(turns, submissions),
    runningTiming: unloaded
      ? readTiming(
          { body: { kind: 'turn', ...unloaded.turn }, observedAt: unloaded.observedAt },
          unloaded.turn.userItemId === undefined
            ? undefined
            : writtenSends(submissions).get(unloaded.turn.userItemId)
        )
      : (turns.byTurnId.get(turnId) ?? null),
    runningKey: turnId
  }
}
