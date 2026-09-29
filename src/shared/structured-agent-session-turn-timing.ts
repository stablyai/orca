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
  /** Host clock this turn's send stopped waiting behind the journal's previous
   *  turn; present only when the send was issued before that turn ended. */
  queuedUntil?: number
  /** Host clock when the lifecycle row was appended; with `startedAt` it gives
   *  the host-side lag a client must subtract to anchor a live counter. */
  observedAt: number
}

function readTiming(
  item: AgentJournalRenderItem,
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
    observedAt: item.observedAt
  }
}

/** One turn record, read in journal order. */
type StructuredAgentJournalTurn = {
  timing: StructuredAgentTurnTiming | null
  /** The transcript key that anchors this turn's bar and owns its rows: the
   *  opener user item when the host names one it can resolve (or the send still
   *  in flight ahead of the record), else the turn record's own item (a turn the
   *  provider opened, or an opener outside the loaded window). Null only for an
   *  older host that names nothing. */
  key: string | null
}

type StructuredAgentJournalTurns = {
  /** Timing keyed by the user message that opened each turn. */
  byUserItem: ReadonlyMap<string, StructuredAgentTurnTiming | null>
  byTurnId: ReadonlyMap<string, StructuredAgentJournalTurn>
}

/** Every turn record in one pass over the journal. A row can name its user
 *  message directly or by a provider key that resolves through its alias.
 *  Rows from older hosts carry no key and fall back, for timing only,
 *  to the nearest user message before them in journal order — the submission
 *  row is written ahead of dispatch, so it always precedes the provider's
 *  turn-start. Untimed rows are skipped unless explicitly unverifiable (null). */
function readStructuredAgentJournalTurns(
  items: readonly AgentJournalRenderItem[],
  submissions: readonly AgentJournalSubmission[] = []
): StructuredAgentJournalTurns {
  const itemIds = new Set(items.map((item) => item.itemId))
  const aliases = new Map<string, string>()
  // Codex folds a send issued mid-turn into the running turn under the SAME provider
  // key, so the earliest submission that names a key is the prompt that opened the turn.
  for (const submission of submissions) {
    if (submission.providerItemId && !aliases.has(submission.providerItemId)) {
      aliases.set(submission.providerItemId, agentJournalSubmissionKey(submission.clientMessageId))
    }
  }
  // Sends not yet matched to a provider item. Codex reports a turn open before it
  // echoes the send, so for that gap the turn names a key no alias resolves yet.
  const inFlight = new Set(
    submissions
      .filter((submission) => submission.dispatchState === 'pending' && !submission.providerItemId)
      .map((submission) => agentJournalSubmissionKey(submission.clientMessageId))
  )
  const byUserItem = new Map<string, StructuredAgentTurnTiming | null>()
  const byTurnId = new Map<string, StructuredAgentJournalTurn>()
  let precedingUserItemId: string | null = null
  let inFlightSinceLastTurn: string | null = null
  let precedingTurnEndedAt: number | undefined
  for (const item of items) {
    if (item.body.kind === 'message' && item.body.role === 'user') {
      precedingUserItemId = item.itemId
      if (inFlightSinceLastTurn === null && inFlight.has(item.itemId)) {
        inFlightSinceLastTurn = item.itemId
      }
      continue
    }
    const turn = readAgentJournalTurn(item.body)
    if (!turn) {
      continue
    }
    const timing = readTiming(item, precedingTurnEndedAt)
    precedingTurnEndedAt = timing?.completedAt ?? item.observedAt
    const key = turn.userItemId
    const named = key === undefined ? null : itemIds.has(key) ? key : (aliases.get(key) ?? null)
    // An unresolved opener is the send still in flight ahead of this record; with none,
    // it is outside the window, and the turn anchors to its own record like a
    // provider-opened one — never to a preceding prompt that did not open it.
    const turnKey = key === undefined ? null : (named ?? inFlightSinceLastTurn ?? item.itemId)
    inFlightSinceLastTurn = null
    byTurnId.set(turn.turnId, { timing, key: turnKey })
    if (!timing && turn.state !== 'unverifiable') {
      continue
    }
    const userItemId = key === undefined ? precedingUserItemId : turnKey
    if (userItemId !== null) {
      byUserItem.set(userItemId, timing)
    }
  }
  return { byUserItem, byTurnId }
}

/**
 * Which turn owns each journal item, as the transcript groups rows: every item
 * between a turn record and the next belongs to that record's turn (the record
 * is appended when the turn opens and revised in place, and an opener's user
 * item is written ahead of dispatch, so journal order is turn order). A user
 * item that opened any turn — even a later one it queued for — keys itself; one
 * the provider folded into a running turn (a steer) takes that turn's key, but
 * only once the turn produces more rows after it, so a fresh tail send is not
 * pulled into the turn it is merely waiting behind. Items before the first turn
 * record stay absent, and the surface keeps its positional grouping for them.
 */
function turnKeysByItemIdOf(
  items: readonly AgentJournalRenderItem[],
  byTurnId: ReadonlyMap<string, StructuredAgentJournalTurn>
): ReadonlyMap<string, string> {
  const openers = new Set<string>()
  for (const turn of byTurnId.values()) {
    if (turn.key !== null) {
      openers.add(turn.key)
    }
  }
  const keys = new Map<string, string>()
  let currentKey: string | null = null
  // User items folded into the current turn, held until a later row proves the
  // turn continued past them.
  let pendingUserItemIds: string[] = []
  for (const item of items) {
    const turn = readAgentJournalTurn(item.body)
    if (turn) {
      currentKey = byTurnId.get(turn.turnId)?.key ?? null
      pendingUserItemIds = []
      continue
    }
    if (item.body.kind === 'message' && item.body.role === 'user') {
      if (openers.has(item.itemId)) {
        keys.set(item.itemId, item.itemId)
      } else if (currentKey !== null) {
        pendingUserItemIds.push(item.itemId)
      }
      continue
    }
    if (currentKey !== null) {
      for (const userItemId of pendingUserItemIds) {
        keys.set(userItemId, currentKey)
      }
      pendingUserItemIds = []
      keys.set(item.itemId, currentKey)
    }
  }
  return keys
}

export function selectStructuredAgentTurnTimings(
  items: readonly AgentJournalRenderItem[],
  submissions: readonly AgentJournalSubmission[] = []
): ReadonlyMap<string, StructuredAgentTurnTiming | null> {
  return readStructuredAgentJournalTurns(items, submissions).byUserItem
}

/** The live turn's lifecycle timing, or null when its row carries no host start
 *  (an older host), in which case a surface falls back to local observation. */
export function selectStructuredAgentRunningTurnTiming(
  items: readonly AgentJournalRenderItem[],
  turnId: string
): StructuredAgentTurnTiming | null {
  return readStructuredAgentJournalTurns(items).byTurnId.get(turnId)?.timing ?? null
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
  for (const [userItemId, timing] of turns.byUserItem) {
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

/** Everything a chat surface reads off the journal for its turn bars, from one
 *  pass: settled durations, the running turn's timing, the item that anchors its
 *  bar — which a message sent while the turn runs is not — and which turn owns
 *  each row of the transcript. */
export function selectStructuredAgentTurnBars(
  items: readonly AgentJournalRenderItem[],
  submissions: readonly AgentJournalSubmission[],
  turnId: string | null
): {
  settledTurns: NativeChatSettledTurns
  runningTiming: StructuredAgentTurnTiming | null
  /** The transcript key the running turn's bar anchors to: its opening user
   *  message, or the turn record itself when the provider opened the turn.
   *  Null on an older host, where the newest user message stays the anchor. */
  activeTurnOpenedBy: string | null
  turnKeysByItemId: ReadonlyMap<string, string>
} {
  const turns = readStructuredAgentJournalTurns(items, submissions)
  const running = turnId === null ? undefined : turns.byTurnId.get(turnId)
  return {
    settledTurns: settledTurnsOf(turns, submissions),
    runningTiming: running?.timing ?? null,
    activeTurnOpenedBy: running?.key ?? null,
    turnKeysByItemId: turnKeysByItemIdOf(items, turns.byTurnId)
  }
}
