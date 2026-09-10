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
import type { NativeChatSettledTurn } from './native-chat-turn-status'

export type StructuredAgentTurnTiming = {
  state: AgentJournalTurnLifecycleState
  /** Host clock at provider turn-start receipt. */
  startedAt: number
  /** Host clock at the terminal provider event; absent while running or unverifiable. */
  completedAt?: number
  /** The provider's own measured duration; outranks the host interval. */
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
  const { state, startedAt, completedAt, durationMs } = turn
  if (startedAt === undefined || !Number.isFinite(startedAt) || startedAt <= 0) {
    return null
  }
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
    ...(end !== undefined ? { completedAt: end } : {}),
    ...(measured !== undefined ? { durationMs: measured } : {}),
    observedAt: item.observedAt
  }
}

/** Timing keyed by the user message that opened each turn. A row names its
 *  user item by provider key; a submission the provider later acknowledged is
 *  reached through its alias. Rows from older hosts carry no key and fall back
 *  to the nearest user message before them in journal order — the submission
 *  row is written ahead of dispatch, so it always precedes the provider's
 *  turn-start. Rows without `startedAt` (conversation commands) are skipped. */
export function selectStructuredAgentTurnTimings(
  items: readonly AgentJournalRenderItem[],
  submissions: readonly AgentJournalSubmission[] = []
): ReadonlyMap<string, StructuredAgentTurnTiming> {
  const itemIds = new Set(items.map((item) => item.itemId))
  const aliases = new Map<string, string>()
  // Codex folds a send issued mid-turn into the running turn under the SAME provider
  // key, so the earliest submission that names a key is the prompt that opened the turn.
  for (const submission of submissions) {
    if (submission.providerItemId && !aliases.has(submission.providerItemId)) {
      aliases.set(submission.providerItemId, agentJournalSubmissionKey(submission.clientMessageId))
    }
  }
  const timings = new Map<string, StructuredAgentTurnTiming>()
  let precedingUserItemId: string | null = null
  for (const item of items) {
    if (item.body.kind === 'message' && item.body.role === 'user') {
      precedingUserItemId = item.itemId
      continue
    }
    const timing = readTiming(item)
    if (!timing) {
      continue
    }
    const key = readAgentJournalTurn(item.body)?.userItemId
    const userItemId =
      key === undefined ? precedingUserItemId : itemIds.has(key) ? key : (aliases.get(key) ?? null)
    if (userItemId !== null) {
      timings.set(userItemId, timing)
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

/** Whole seconds a settled turn ran, or null when the host never observed its end. */
export function completedStructuredAgentTurnSeconds(
  timing: StructuredAgentTurnTiming | undefined
): number | null {
  if (!timing || (timing.state !== 'completed' && timing.state !== 'interrupted')) {
    return null
  }
  if (timing.durationMs !== undefined) {
    return Math.floor(timing.durationMs / 1000)
  }
  return timing.completedAt !== undefined
    ? Math.floor((timing.completedAt - timing.startedAt) / 1000)
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
  const hostElapsed =
    hostNow !== undefined && Number.isFinite(hostNow)
      ? hostNow - timing.startedAt
      : timing.observedAt - timing.startedAt
  return firstSeenAt - Math.max(0, hostElapsed)
}

/** The settled turns a chat surface hands to the shared turn-status selector. */
export function selectStructuredAgentSettledTurns(
  items: readonly AgentJournalRenderItem[],
  submissions: readonly AgentJournalSubmission[] = []
): ReadonlyMap<string, NativeChatSettledTurn> {
  const settled = new Map<string, NativeChatSettledTurn>()
  for (const [userItemId, timing] of selectStructuredAgentTurnTimings(items, submissions)) {
    const workedSeconds = completedStructuredAgentTurnSeconds(timing)
    if (workedSeconds !== null) {
      settled.set(userItemId, { startedAt: timing.startedAt, workedSeconds })
    }
  }
  return settled
}
