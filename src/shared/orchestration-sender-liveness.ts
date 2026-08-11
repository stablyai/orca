// Sender liveness evidence carried by every Delivery message.
//
// The runtime already knows, when it hands a Delivery to a coordinator, whether
// the sender is mid-turn and when its last turn boundary was. Publishing that
// with the message saves the coordinator a `worker-show` + `terminal read` round
// trip per wake. Evidence is decoration on an existing batch: it never changes
// which messages a Delivery contains.

/** Sender liveness verdict. `unknown` covers missing, stale, untrusted and
 *  remote evidence — those never get promoted to `working` or `idle`. */
export const SENDER_LIVENESS_STATES = ['working', 'blocked', 'waiting', 'idle', 'unknown'] as const

export type SenderLivenessState = (typeof SENDER_LIVENESS_STATES)[number]

/** What produced the verdict:
 *  - `agent_status`: a fresh turn-lifecycle row from the sender's installed hook,
 *    extension or plugin.
 *  - `stale_agent_status`: such a row exists but is older than the freshness
 *    window, or was restored without a live confirmation.
 *  - `no_agent_status`: the sender's pane resolves but its harness reports no
 *    semantic status.
 *  - `sender_unresolved`: the sender's pane and handle no longer resolve here.
 *  - `federated`: the sender runs on another Orca server, so this runtime holds
 *    no turn evidence for it.
 *  - `unavailable`: evidence resolution failed; the Delivery is unaffected. */
export const SENDER_LIVENESS_SOURCES = [
  'agent_status',
  'stale_agent_status',
  'no_agent_status',
  'sender_unresolved',
  'federated',
  'unavailable'
] as const

// Why: string union stays open like AgentType — a newer host may publish a source
// this reader has never heard of, and that must render rather than fail.
export type SenderLivenessSource = (typeof SENDER_LIVENESS_SOURCES)[number] | (string & {})

export type SenderLivenessDispatch = {
  id: string
  /** Runtime worker-dispatch state (`ready`, `succeeded`, …); null when the
   *  dispatch has no worker row. Never used to derive the liveness verdict. */
  state: string | null
}

export type SenderLivenessEvidence = {
  state: SenderLivenessState
  source: SenderLivenessSource
  /** ISO timestamp of the newest status observation, or null when there is none.
   *  Present on stale evidence too, so a reader can see how old it is. */
  observedAt: string | null
  /** ISO timestamp of the sender's last observed turn boundary — when it entered
   *  the reported state. Null unless the verdict came from a trusted status row. */
  turnStartedAt: string | null
  /** Remint-stable sender identity the evidence was resolved from. */
  paneKey: string | null
  /** Present only when the message belongs to a dispatch. */
  dispatch?: SenderLivenessDispatch
}

/** Raw turn-lifecycle observation for a sender, before freshness or trust is
 *  judged. The runtime produces it; classification happens above it. */
export type SenderAgentTurnObservation = {
  state: 'working' | 'blocked' | 'waiting' | 'done'
  /** Newest status update for the sender (ms). */
  updatedAt: number
  /** When the sender entered `state` (ms) — the last observed turn boundary. */
  turnStartedAt: number
  /** True for a hydrated row with no live event since; treated as untrusted. */
  restoredUnconfirmed: boolean
  paneKey: string | null
}

export function unknownSenderLiveness(
  source: SenderLivenessSource,
  fields: Partial<Omit<SenderLivenessEvidence, 'state' | 'source'>> = {}
): SenderLivenessEvidence {
  return {
    state: 'unknown',
    source,
    observedAt: fields.observedAt ?? null,
    turnStartedAt: fields.turnStartedAt ?? null,
    paneKey: fields.paneKey ?? null,
    ...(fields.dispatch ? { dispatch: fields.dispatch } : {})
  }
}

const SECOND_MS = 1000
const MINUTE_MS = 60 * SECOND_MS
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

/** Compact age like `12s`, `3m`, `5h`, `2d`; null when the timestamp is absent
 *  or unparseable. */
export function formatSenderLivenessAge(isoTimestamp: string | null, now: number): string | null {
  if (!isoTimestamp) {
    return null
  }
  const observedAt = Date.parse(isoTimestamp)
  if (Number.isNaN(observedAt)) {
    return null
  }
  const age = Math.max(0, now - observedAt)
  if (age < MINUTE_MS) {
    return `${Math.round(age / SECOND_MS)}s`
  }
  if (age < HOUR_MS) {
    return `${Math.floor(age / MINUTE_MS)}m`
  }
  if (age < DAY_MS) {
    return `${Math.floor(age / HOUR_MS)}h`
  }
  return `${Math.floor(age / DAY_MS)}d`
}

function livenessParts(evidence: SenderLivenessEvidence, now: number): string[] {
  const parts: string[] = []
  const turn = formatSenderLivenessAge(evidence.turnStartedAt, now)
  if (turn) {
    parts.push(`turn ${turn}`)
  }
  const seen = formatSenderLivenessAge(evidence.observedAt, now)
  if (seen) {
    parts.push(`seen ${seen}`)
  }
  parts.push(`via ${evidence.source}`)
  if (evidence.dispatch) {
    parts.push(`dispatch ${evidence.dispatch.id}${dispatchStateSuffix(evidence.dispatch.state)}`)
  }
  return parts
}

function dispatchStateSuffix(state: string | null): string {
  return state ? ` ${state}` : ''
}

/** One compact banner line, e.g.
 *  `[Sender: working, turn 3m, seen 12s, via agent_status, dispatch dsp_1 ready]`. */
export function formatSenderLivenessLine(
  evidence: SenderLivenessEvidence,
  now = Date.now()
): string {
  return `[Sender: ${evidence.state}, ${livenessParts(evidence, now).join(', ')}]`
}

/** Suffix for one-line message listings, e.g. ` sender=working seen=12s`. */
export function formatSenderLivenessTag(
  evidence: SenderLivenessEvidence | undefined,
  now = Date.now()
): string {
  if (!evidence) {
    return ''
  }
  const state = evidence.state === 'unknown' ? `unknown(${evidence.source})` : `${evidence.state}`
  const seen = formatSenderLivenessAge(evidence.observedAt, now)
  return ` sender=${state}${seen ? ` seen=${seen}` : ''}`
}
