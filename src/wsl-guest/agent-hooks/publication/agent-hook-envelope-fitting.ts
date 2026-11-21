import {
  AGENT_HOOK_NOTIFICATION_METHOD,
  AGENT_HOOK_SHED_FIELDS_KEY,
  createShedSubagentsField,
  type AgentHookRelayEnvelope
} from '../../../shared/agent-hook-listener/transport/agent-hook-relay'
import { fitInteractivePrompt } from '../../../shared/agent-status/contracts/agent-status-field-normalization'
import type { RelayDispatcher } from '../../transport/publication/dispatcher'

// Shed reconstructible fields first; keep state/paneKey and preserve interactivePrompt longest so waiting panes remain answerable.
// Mark shed rosters on the wire so clients restore cached subagents instead of permitting hibernation.
const SHED_ORDER = ['lastAssistantMessage', 'subagents', 'interactivePrompt'] as const

export type HookParams = AgentHookRelayEnvelope & {
  [AGENT_HOOK_SHED_FIELDS_KEY]?: readonly string[]
}

export function fitsProducerFrame(
  dispatcher: RelayDispatcher,
  params: Record<string, unknown>
): boolean {
  return dispatcher.producerEnvelopeBudget(AGENT_HOOK_NOTIFICATION_METHOD, params) >= 0
}

function toNotificationParams(
  envelope: AgentHookRelayEnvelope,
  shedFields: readonly string[]
): HookParams {
  return shedFields.length === 0
    ? envelope
    : { ...envelope, [AGENT_HOOK_SHED_FIELDS_KEY]: [...shedFields] }
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
export function publishToClients(
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

export function logUnsendableEnvelope(
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

// An empty target list fits an envelope for redelivery without publishing it.
export function deliverHook(
  dispatcher: RelayDispatcher,
  envelope: AgentHookRelayEnvelope,
  previouslyShed: readonly string[],
  clientIds: readonly number[]
): { params: HookParams; rejected: number[] } | undefined {
  // Measure all fan-out sinks before writing so none receive an unshed variant; a single rejecting sink writes nothing.
  const measureBeforePublish = clientIds.length !== 1
  let candidate = envelope
  const shedFields = [...previouslyShed]
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
        return { params, rejected }
      }
      // Rejection is ambiguous: an over-capacity frame must shed, a full producer queue must wait.
      if (measureBeforePublish || fitsProducerFrame(dispatcher, params)) {
        return { params, rejected }
      }
    }
    if (step >= SHED_ORDER.length) {
      // An irreducibly oversized snapshot cannot improve by waiting and supersedes any older pending snapshot.
      if (measureBeforePublish) {
        logUnsendableEnvelope(dispatcher, params, clientIds)
      }
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
