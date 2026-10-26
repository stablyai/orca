import {
  AGENT_HOOK_NOTIFICATION_METHOD,
  AGENT_HOOK_SHED_FIELDS_KEY,
  createShedSubagentsField,
  type AgentHookUnavailableEnvelope,
  type AgentHookRelayEnvelope
} from '../shared/agent-hook-relay'
import { fitInteractivePrompt } from '../shared/agent-status-field-normalization'
import type { RelayDispatcher } from './dispatcher'

// Shed reconstructible fields first; keep state/paneKey and preserve interactivePrompt longest so waiting panes remain answerable.
// Mark shed rosters on the wire so clients restore cached subagents instead of permitting hibernation.
const SHED_ORDER = ['lastAssistantMessage', 'subagents', 'interactivePrompt'] as const

// Snapshots have no ack; briefly retry queue-full rejection so stale state need not wait for reattach replay.
const REDELIVERY_INTERVAL_MS = 250
const MAX_REDELIVERY_ATTEMPTS = 40
// Why: a wedged link must not pin snapshots for panes that are already gone; recency-evict the rest.
const MAX_PENDING_PANES = 64

type PendingEnvelope = {
  params: Record<string, unknown>
  clientIds: readonly number[]
  /** Zero means the timer budget is exhausted and one capacity-driven attempt remains. */
  attemptsLeft: number
}

type RedeliveryState = {
  pending: Map<string, PendingEnvelope>
  timer: ReturnType<typeof setInterval> | null
}

const redeliveryByDispatcher = new WeakMap<RelayDispatcher, RedeliveryState>()

function fitsProducerFrame(dispatcher: RelayDispatcher, params: Record<string, unknown>): boolean {
  return dispatcher.producerEnvelopeBudget(AGENT_HOOK_NOTIFICATION_METHOD, params) >= 0
}

function toNotificationParams(
  envelope: AgentHookRelayEnvelope,
  shedFields: readonly string[]
): Record<string, unknown> {
  const params = envelope as unknown as Record<string, unknown>
  return shedFields.length === 0
    ? params
    : { ...params, [AGENT_HOOK_SHED_FIELDS_KEY]: [...shedFields] }
}

function fitWaitingInteractivePrompt(
  dispatcher: RelayDispatcher,
  envelope: AgentHookRelayEnvelope,
  shedFields: readonly string[]
): AgentHookRelayEnvelope | null {
  const prompt = envelope.payload.interactivePrompt
  if (!prompt) {
    return null
  }
  const fitted = fitInteractivePrompt(prompt, (interactivePrompt) =>
    fitsProducerFrame(
      dispatcher,
      toNotificationParams(
        { ...envelope, payload: { ...envelope.payload, interactivePrompt } },
        shedFields
      )
    )
  )
  return fitted === null
    ? null
    : { ...envelope, payload: { ...envelope.payload, interactivePrompt: fitted } }
}

/** Returns the ids of the clients that rejected the frame; a rejected client is never written to. */
function publishToClients(
  dispatcher: RelayDispatcher,
  params: Record<string, unknown>,
  clientIds: readonly number[],
  logDrop?: boolean
): number[] {
  const rejected: number[] = []
  for (const clientId of clientIds) {
    if (
      !dispatcher.publishProducerNotification(
        clientId,
        AGENT_HOOK_NOTIFICATION_METHOD,
        params,
        logDrop === undefined ? undefined : { logDrop }
      )
    ) {
      rejected.push(clientId)
    }
  }
  return rejected
}

function logUnsendableEnvelope(
  dispatcher: RelayDispatcher,
  params: Record<string, unknown>,
  clientIds: readonly number[]
): void {
  const rejectedClientId = clientIds.find(
    (clientId) =>
      dispatcher.producerEnvelopeBudget(AGENT_HOOK_NOTIFICATION_METHOD, params, clientId) < 0
  )
  if (rejectedClientId !== undefined) {
    publishToClients(dispatcher, params, [rejectedClientId], true)
  }
}

// Fit one envelope to every sink by shedding optional fields; retry queue-full frames, drop frames that cannot fit.
export function publishAgentHookEnvelope(
  dispatcher: RelayDispatcher,
  envelope: AgentHookRelayEnvelope | AgentHookUnavailableEnvelope
): void {
  const clientIds = dispatcher.activeClientIds()
  if (clientIds.length === 0) {
    return
  }
  if (envelope.payload === null) {
    const params = { ...envelope }
    if (!fitsProducerFrame(dispatcher, params)) {
      clearPendingEnvelope(dispatcher, envelope.paneKey)
      logUnsendableEnvelope(dispatcher, params, clientIds)
      return
    }
    const rejected = publishToClients(dispatcher, params, clientIds)
    if (rejected.length === 0) {
      clearPendingEnvelope(dispatcher, envelope.paneKey)
    } else {
      setPendingEnvelope(dispatcher, envelope.paneKey, params, rejected)
    }
    return
  }
  // Measure all fan-out sinks before writing so none receive an unshed variant; a single rejecting sink writes nothing.
  const measureBeforePublish = clientIds.length > 1
  let candidate = envelope
  const shedFields: string[] = []
  let step = 0
  for (;;) {
    const params = toNotificationParams(candidate, shedFields)
    while (step < SHED_ORDER.length && candidate.payload[SHED_ORDER[step]] === undefined) {
      step += 1
    }
    if (!measureBeforePublish || fitsProducerFrame(dispatcher, params)) {
      // A rejected intermediate probe is not a drop if a smaller envelope is delivered next.
      const rejected = publishToClients(
        dispatcher,
        params,
        clientIds,
        measureBeforePublish ? undefined : step >= SHED_ORDER.length
      )
      if (rejected.length === 0) {
        clearPendingEnvelope(dispatcher, envelope.paneKey)
        return
      }
      // Rejection is ambiguous: an over-capacity frame must shed, a full producer queue must wait.
      if (measureBeforePublish || fitsProducerFrame(dispatcher, params)) {
        setPendingEnvelope(dispatcher, envelope.paneKey, params, rejected)
        return
      }
    }
    if (step >= SHED_ORDER.length) {
      // An irreducibly oversized snapshot cannot improve by waiting and supersedes any older pending snapshot.
      if (measureBeforePublish) {
        logUnsendableEnvelope(dispatcher, params, clientIds)
      }
      clearPendingEnvelope(dispatcher, envelope.paneKey)
      return
    }
    const field = SHED_ORDER[step]
    step += 1
    if (field === 'interactivePrompt' && candidate.payload.state === 'waiting') {
      const fitted = fitWaitingInteractivePrompt(dispatcher, candidate, shedFields)
      if (fitted) {
        candidate = fitted
        continue
      }
      // A waiting snapshot without an answerable card must not reach web/mobile.
      logUnsendableEnvelope(dispatcher, params, clientIds)
      clearPendingEnvelope(dispatcher, envelope.paneKey)
      return
    }
    // Copy before shedding: the server caches this envelope for reconnect replay.
    candidate = { ...candidate, payload: { ...candidate.payload } }
    const shedField =
      field === 'subagents' ? createShedSubagentsField(candidate.payload.subagents ?? []) : field
    delete candidate.payload[field]
    shedFields.push(shedField)
  }
}

function setPendingEnvelope(
  dispatcher: RelayDispatcher,
  paneKey: string,
  params: Record<string, unknown>,
  clientIds: readonly number[]
): void {
  let state = redeliveryByDispatcher.get(dispatcher)
  if (!state) {
    state = { pending: new Map(), timer: null }
    redeliveryByDispatcher.set(dispatcher, state)
    // A disposed dispatcher can never accept the retry, and pending params pin the cached payload.
    dispatcher.onDisposed(() => stopRedelivery(dispatcher))
    dispatcher.onLegacyPtyCapacity(() => runFinalCapacityPass(dispatcher))
  }
  // Keep only the newest snapshot per pane; delete/set makes recency eviction follow Map order.
  state.pending.delete(paneKey)
  state.pending.set(paneKey, { params, clientIds, attemptsLeft: MAX_REDELIVERY_ATTEMPTS })
  while (state.pending.size > MAX_PENDING_PANES) {
    state.pending.delete(state.pending.keys().next().value as string)
  }
  if (!state.timer) {
    const timer = setInterval(() => runRedeliveryPass(dispatcher), REDELIVERY_INTERVAL_MS)
    if (typeof timer.unref === 'function') {
      timer.unref()
    }
    state.timer = timer
  }
}

function clearPendingEnvelope(dispatcher: RelayDispatcher, paneKey: string): void {
  const state = redeliveryByDispatcher.get(dispatcher)
  if (!state?.pending.delete(paneKey) || state.pending.size > 0) {
    return
  }
  stopRedelivery(dispatcher)
}

function stopRedelivery(dispatcher: RelayDispatcher): void {
  const state = redeliveryByDispatcher.get(dispatcher)
  if (!state) {
    return
  }
  state.pending.clear()
  if (state.timer) {
    clearInterval(state.timer)
    state.timer = null
  }
}

function stopRedeliveryTimer(state: RedeliveryState): void {
  if (state.timer) {
    clearInterval(state.timer)
    state.timer = null
  }
}

function runRedeliveryPass(dispatcher: RelayDispatcher): void {
  const state = redeliveryByDispatcher.get(dispatcher)
  if (!state) {
    return
  }
  const active = new Set(dispatcher.activeClientIds())
  for (const [paneKey, pending] of Array.from(state.pending)) {
    if (pending.attemptsLeft <= 0) {
      continue
    }
    // A client that detached gets caught up by the reattach replay, so stop tracking it.
    const targets = pending.clientIds.filter((clientId) => active.has(clientId))
    const rejected =
      targets.length === 0 ? [] : publishToClients(dispatcher, pending.params, targets)
    pending.attemptsLeft -= 1
    if (rejected.length === 0) {
      state.pending.delete(paneKey)
      continue
    }
    pending.clientIds = rejected
  }
  if (state.pending.size === 0) {
    stopRedelivery(dispatcher)
  } else if (Array.from(state.pending.values()).every((pending) => pending.attemptsLeft <= 0)) {
    stopRedeliveryTimer(state)
  }
}

function runFinalCapacityPass(dispatcher: RelayDispatcher): void {
  const state = redeliveryByDispatcher.get(dispatcher)
  if (!state) {
    return
  }
  const active = new Set(dispatcher.activeClientIds())
  for (const [paneKey, pending] of Array.from(state.pending)) {
    if (pending.attemptsLeft > 0) {
      continue
    }
    // Delete before publishing because a synchronous sink settlement emits capacity reentrantly.
    state.pending.delete(paneKey)
    const targets = pending.clientIds.filter((clientId) => active.has(clientId))
    if (targets.length > 0) {
      publishToClients(dispatcher, pending.params, targets)
    }
  }
  if (state.pending.size === 0) {
    stopRedelivery(dispatcher)
  }
}
