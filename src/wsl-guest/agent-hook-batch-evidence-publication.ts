import {
  AGENT_HOOK_NOTIFICATION_METHOD,
  AGENT_HOOK_SHED_FIELDS_KEY,
  createShedSubagentsField,
  type AgentHookRelayEnvelope
} from '../shared/agent-hook-relay'
import type { RelayDispatcher } from './dispatcher'

// Why separate from row snapshots: a batch's settlement must reach each receiver whole, and a newer row
// snapshot for the pane must not replace proof a receiver holding an older request still needs.
// Why a bound: a permanently saturated peer is a reconnect-replay boundary, not unlimited retention.
const MAX_PENDING_FRAGMENTS = 256

type PendingFragment = { params: Record<string, unknown>; clientIds: number[] }
type EvidenceState = { pending: PendingFragment[]; draining: boolean; again: boolean }

const evidenceByDispatcher = new WeakMap<RelayDispatcher, EvidenceState>()

/** A live batch carrying settlement ids; replays carry the bounded history and publish as rows. */
export function isBatchEvidenceEnvelope(envelope: AgentHookRelayEnvelope): boolean {
  return (
    envelope.payload !== null &&
    envelope.hookEventName === 'PostToolBatch' &&
    envelope.isReplay !== true &&
    (envelope.claudeBatchSettledRequests?.length ?? 0) > 0
  )
}

function budget(dispatcher: RelayDispatcher, params: Record<string, unknown>): number {
  return dispatcher.producerEnvelopeBudget(AGENT_HOOK_NOTIFICATION_METHOD, params)
}

/** Sheds the same optional fields row publication does until one id fits; null when nothing can. */
function fragmentBase(
  dispatcher: RelayDispatcher,
  envelope: AgentHookRelayEnvelope
): Record<string, unknown> | null {
  const [first] = envelope.claudeBatchSettledRequests ?? []
  let payload = { ...envelope.payload }
  const shed: string[] = []
  const withIds = (ids: readonly unknown[]): Record<string, unknown> => ({
    ...envelope,
    payload,
    claudeBatchSettledRequests: ids,
    ...(shed.length ? { [AGENT_HOOK_SHED_FIELDS_KEY]: [...shed] } : {})
  })
  for (const field of ['lastAssistantMessage', 'subagents'] as const) {
    if (budget(dispatcher, withIds([first])) >= 0) {
      return withIds([])
    }
    if (payload[field] !== undefined) {
      shed.push(field === 'subagents' ? createShedSubagentsField(payload.subagents ?? []) : field)
      const { [field]: _shed, ...rest } = payload
      payload = rest
    }
  }
  // A waiting card stays whole; evidence never erases what a receiver must answer.
  return budget(dispatcher, withIds([first])) >= 0 ? withIds([]) : null
}

/** Every valid id, in fragments that each fit the smallest attached sink and stand alone at the receiver. */
function fragments(
  dispatcher: RelayDispatcher,
  envelope: AgentHookRelayEnvelope
): Record<string, unknown>[] | null {
  const whole = envelope as unknown as Record<string, unknown>
  if (budget(dispatcher, whole) >= 0) {
    return [whole]
  }
  const base = fragmentBase(dispatcher, envelope)
  if (!base) {
    return null
  }
  const ids = envelope.claudeBatchSettledRequests ?? []
  const room = budget(dispatcher, base)
  const out: Record<string, unknown>[] = []
  let start = 0
  while (start < ids.length) {
    let end = start
    let used = 0
    // Each entry adds its own JSON plus a separator; the check below catches any estimate drift.
    while (end < ids.length) {
      const bytes = Buffer.byteLength(JSON.stringify(ids[end])) + 1
      if (end > start && used + bytes > room) {
        break
      }
      used += bytes
      end += 1
    }
    let candidate = { ...base, claudeBatchSettledRequests: ids.slice(start, end) }
    while (budget(dispatcher, candidate) < 0 && end - start > 1) {
      end = start + Math.ceil((end - start) / 2)
      candidate = { ...base, claudeBatchSettledRequests: ids.slice(start, end) }
    }
    out.push(candidate)
    start = end
  }
  return out
}

function publishTo(
  dispatcher: RelayDispatcher,
  params: Record<string, unknown>,
  clientIds: readonly number[]
): number[] {
  return clientIds.filter(
    (clientId) =>
      !dispatcher.publishProducerNotification(clientId, AGENT_HOOK_NOTIFICATION_METHOD, params)
  )
}

function evidenceState(dispatcher: RelayDispatcher): EvidenceState {
  let state = evidenceByDispatcher.get(dispatcher)
  if (!state) {
    const created: EvidenceState = { pending: [], draining: false, again: false }
    state = created
    evidenceByDispatcher.set(dispatcher, created)
    dispatcher.onDisposed(() => {
      created.pending = []
    })
    dispatcher.onLegacyPtyCapacity(() => drainEvidence(dispatcher, created))
  }
  return state
}

/** Retries owed fragments in order when capacity returns; a detached client is caught up by reattach replay. */
function drainEvidence(dispatcher: RelayDispatcher, state: EvidenceState): void {
  if (state.draining) {
    // A synchronous sink settlement can signal capacity mid-pass; run once more after it.
    state.again = true
    return
  }
  state.draining = true
  try {
    do {
      state.again = false
      const active = new Set(dispatcher.activeClientIds())
      const owed = state.pending
      state.pending = []
      for (const fragment of owed) {
        const targets = fragment.clientIds.filter((clientId) => active.has(clientId))
        const rejected = targets.length ? publishTo(dispatcher, fragment.params, targets) : []
        if (rejected.length) {
          state.pending.push({ params: fragment.params, clientIds: rejected })
        }
      }
    } while (state.again && state.pending.length > 0)
  } finally {
    state.draining = false
  }
}

/** Publish a live batch's settlement completely; returns false only when no fragment can ever fit. */
export function publishBatchEvidence(
  dispatcher: RelayDispatcher,
  envelope: AgentHookRelayEnvelope,
  clientIds: readonly number[]
): boolean {
  const parts = fragments(dispatcher, envelope)
  if (!parts) {
    return false
  }
  const state = evidenceState(dispatcher)
  for (const params of parts) {
    // Owed fragments go first to a client, so later evidence never overtakes it.
    const behind = new Set(state.pending.flatMap((fragment) => fragment.clientIds))
    const ready = clientIds.filter((clientId) => !behind.has(clientId))
    const rejected = [
      ...publishTo(dispatcher, params, ready),
      ...clientIds.filter((clientId) => behind.has(clientId))
    ]
    if (rejected.length) {
      state.pending.push({ params, clientIds: rejected })
    }
  }
  if (state.pending.length > MAX_PENDING_FRAGMENTS) {
    state.pending.splice(0, state.pending.length - MAX_PENDING_FRAGMENTS)
  }
  return true
}
