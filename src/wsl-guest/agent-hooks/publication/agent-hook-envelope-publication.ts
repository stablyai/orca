import {
  AGENT_HOOK_SHED_FIELDS_KEY,
  type AgentHookUnavailableEnvelope,
  type AgentHookRelayEnvelope
} from '../../../shared/agent-hook-listener/transport/agent-hook-relay'
import { isSameAgentProcess } from '../../../shared/agent-status/process/agent-process-presence'
import type { RelayDispatcher } from '../../transport/publication/dispatcher'

import {
  deliverHook,
  fitsProducerFrame,
  logUnsendableEnvelope,
  publishToClients,
  type HookParams
} from './agent-hook-envelope-fitting'

// Snapshots have no ack; briefly retry queue-full rejection so stale state need not wait for reattach replay.
const REDELIVERY_INTERVAL_MS = 250
const MAX_REDELIVERY_ATTEMPTS = 40
// Why: a wedged link must not pin snapshots for panes that are already gone; recency-evict the rest.
const MAX_PENDING_PANES = 64

type PendingEnvelope = {
  params: HookParams | AgentHookUnavailableEnvelope
  clientIds: readonly number[]
  /** Zero means the timer budget is exhausted and one capacity-driven attempt remains. */
  attemptsLeft: number
}

type RedeliveryState = {
  pending: Map<string, PendingEnvelope>
  timer: ReturnType<typeof setInterval> | null
}

const redeliveryByDispatcher = new WeakMap<RelayDispatcher, RedeliveryState>()

function sameHookOwner(prior: AgentHookRelayEnvelope, next: AgentHookRelayEnvelope): boolean {
  const before = prior.agentPresence
  const after = next.agentPresence
  return (
    prior.source === next.source &&
    prior.payload.agentType === next.payload.agentType &&
    prior.worktreeId === next.worktreeId &&
    prior.tabId === next.tabId &&
    prior.launchToken === next.launchToken &&
    prior.providerSession?.id === next.providerSession?.id &&
    prior.hostTurnRevision === next.hostTurnRevision &&
    prior.promptInteractionKey === next.promptInteractionKey &&
    !prior.providerSessionOnly &&
    !before?.ended &&
    !after?.ended &&
    before?.session === after?.session &&
    before?.paneRoot === after?.paneRoot &&
    (before?.process && after?.process
      ? isSameAgentProcess(before.process, after.process)
      : before?.process === after?.process) &&
    prior.payload.prompt === next.payload.prompt
  )
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
  if (envelope.modelOnly) {
    const pending = redeliveryByDispatcher.get(dispatcher)?.pending.get(envelope.paneKey)
    if (pending) {
      if (pending.params.payload === null || !sameHookOwner(pending.params, envelope)) {
        return
      }
      if (!pending.params.modelOnly) {
        const { [AGENT_HOOK_SHED_FIELDS_KEY]: shedFields = [], ...prior } = pending.params
        const fitted = deliverHook(
          dispatcher,
          { ...prior, payload: { ...prior.payload, model: envelope.payload.model } },
          shedFields,
          []
        )?.params
        // Clients that already got the hook can accept the narrower metadata publication.
        const awaitingHook = new Set(pending.clientIds)
        const targets = clientIds.filter((id) => !awaitingHook.has(id))
        const hookDebt = clientIds.filter((id) => awaitingHook.has(id))
        if (fitted) {
          setPendingEnvelope(dispatcher, envelope.paneKey, fitted, hookDebt)
        }
        const model =
          targets.length > 0 ? deliverHook(dispatcher, envelope, [], targets) : undefined
        if (fitted && model?.rejected.length) {
          setPendingEnvelope(dispatcher, envelope.paneKey, fitted, [...hookDebt, ...model.rejected])
        }
        return
      }
    }
  }
  const delivery = deliverHook(dispatcher, envelope, [], clientIds)
  if (!delivery?.rejected.length) {
    clearPendingEnvelope(dispatcher, envelope.paneKey)
  } else {
    setPendingEnvelope(dispatcher, envelope.paneKey, delivery.params, delivery.rejected)
  }
}

function setPendingEnvelope(
  dispatcher: RelayDispatcher,
  paneKey: string,
  params: PendingEnvelope['params'],
  clientIds: readonly number[]
): void {
  if (clientIds.length === 0) {
    clearPendingEnvelope(dispatcher, paneKey)
    return
  }
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
