import type { AgentHookSource } from '../agent-hook-relay'
import type { AgentHookEventPayload } from './listener-event'
import { providerCurrentTurnInventory } from './provider-turn-inventory'
import { providerTurnEventId } from './provider-turn-event-id'
import { normalizeProviderTurnIdentity } from './provider-turn-identity'
import type {
  ProviderInterruptEvidenceInput,
  ProviderTurnEvidence,
  ProviderTurnEvidenceInput,
  ProviderTurnEvidenceRead,
  ProviderTurnOutcome,
  ProviderWorkKind
} from './provider-turn-evidence-types'

export type {
  ProviderCurrentTurnInventory,
  ProviderInterruptEvidenceInput,
  ProviderTerminalTurnRecordInput,
  ProviderTurnEvidence,
  ProviderTurnEvidenceInput,
  ProviderTurnEvidenceRead,
  ProviderTurnInventoryWork,
  ProviderTurnOutcome,
  ProviderWorkKind
} from './provider-turn-evidence-types'
export { providerCurrentTurnInventory } from './provider-turn-inventory'
export { normalizeProviderTurnInventoryFields } from './provider-turn-inventory'
export { readProviderTerminalTurnRecord } from './provider-turn-terminal-record'

const TURN_START_EVENTS = new Set([
  'UserPromptSubmit',
  'user_prompt_submit',
  'before_agent_start',
  'agent_start',
  'SessionBusy',
  'session_busy',
  'MessagePart',
  'message_part',
  'turn_started',
  'turn/started',
  'prompt_submitted'
])
const TURN_OUTCOME_EVENTS = new Set([
  'Stop',
  'StopFailure',
  'StopCancelled',
  'stop_cancelled',
  'stop',
  'stop_failure',
  'SessionIdle',
  'session_idle',
  'agent_end',
  'turn_completed',
  'turn/completed',
  'turn_cancelled',
  'turn/cancelled',
  'turn/interrupted',
  'interrupt_acknowledged',
  'interrupted',
  'cancelled'
])
const CHILD_START_EVENTS = new Set(['SubagentStart', 'subagent_start', 'child_started'])
const CHILD_OUTCOME_EVENTS = new Set([
  'SubagentStop',
  'subagent_stop',
  'TeammateIdle',
  'teammate_idle',
  'child_completed',
  'child_failed'
])
const INTERRUPT_EVENTS = new Set([
  'StopCancelled',
  'stop_cancelled',
  'turn_cancelled',
  'turn/interrupted',
  'interrupt_acknowledged',
  'interrupted',
  'cancelled'
])
/** Normalize an optional provider turn key before it is retained in a transport envelope. */
export function normalizeProviderTurnId(value: unknown): string | undefined {
  return normalizeProviderTurnIdentity(value)
}

function outcomeFor(name: string, payload: AgentHookEventPayload['payload']): ProviderTurnOutcome {
  if (payload.interrupted === true || INTERRUPT_EVENTS.has(name)) {
    return 'interrupted'
  }
  return name === 'StopFailure' || name === 'stop_failure' || name === 'StopCancelled'
    ? 'failed'
    : 'completed'
}

function isTerminalTurnOutcome(
  source: AgentHookSource,
  name: string,
  providerTurnTerminal: boolean | undefined
): boolean {
  // Pi-compatible CLIs can emit agent_end between internal steps. Only an explicit terminal
  // marker (or a provider other than that family) may settle a root turn.
  if ((source === 'pi' || source === 'omp' || source === 'prime-agent') && name === 'agent_end') {
    return providerTurnTerminal === true
  }
  return true
}

function readTurnId(event: ProviderTurnEvidenceInput['event']): string | undefined {
  return (
    normalizeProviderTurnId(event.providerTurnId) ?? normalizeProviderTurnId(event.providerPromptId)
  )
}

function readChildEvidence(
  input: ProviderTurnEvidenceInput,
  observedAt: number,
  name: string,
  turnId: string | undefined
): ProviderTurnEvidence[] {
  const workId = normalizeProviderTurnIdentity(input.event.toolAgentId)
  if (!workId) {
    return []
  }
  const workKind: ProviderWorkKind = input.event.residentBackgroundWorkIds?.includes(workId)
    ? 'resident-background'
    : 'joined-child'
  const eventIdValue = providerTurnEventId(
    input.event.source ?? 'claude',
    input.event.paneKey,
    name,
    turnId,
    TURN_OUTCOME_EVENTS.has(name) ? outcomeFor(name, input.event.payload) : undefined,
    'event',
    workId
  )
  const childOutcome =
    CHILD_OUTCOME_EVENTS.has(name) ||
    (TURN_OUTCOME_EVENTS.has(name) &&
      isTerminalTurnOutcome(input.event.source ?? 'claude', name, input.event.providerTurnTerminal))
  if (childOutcome) {
    return [
      {
        source: input.event.source ?? 'claude',
        producerId: `provider:${input.event.source ?? 'unknown'}`,
        eventId: eventIdValue,
        observedAt,
        kind: 'work-outcome-observed',
        turnId,
        outcome: outcomeFor(name, input.event.payload),
        recordKind: 'event',
        workId,
        workKind
      }
    ]
  }
  if (
    CHILD_START_EVENTS.has(name) ||
    TURN_START_EVENTS.has(name) ||
    input.event.payload.state === 'working'
  ) {
    return [
      {
        source: input.event.source ?? 'claude',
        producerId: `provider:${input.event.source ?? 'unknown'}`,
        eventId: eventIdValue,
        observedAt,
        kind: 'work-started',
        turnId,
        workId,
        workKind
      }
    ]
  }
  return []
}

/**
 * Extract provider evidence without deciding the aggregate row state. The caller must supply
 * C5's bound attachment/run owner before forwarding the result to the shared C1 reducer.
 */
export function readProviderTurnEvidence(
  input: ProviderTurnEvidenceInput
): ProviderTurnEvidenceRead {
  const source = input.event.source
  if (!source) {
    return { evidence: [], ignored: 'unsupported' }
  }
  const parsedName = normalizeProviderTurnIdentity(input.event.hookEventName)
  if (!parsedName && input.event.currentTurnInventoryComplete !== true) {
    return { evidence: [], ignored: 'unsupported' }
  }
  const name = parsedName ?? 'current-turn-inventory'
  const observedAt = input.observedAt ?? Date.now()
  const turnId = readTurnId(input.event)
  const evidence: ProviderTurnEvidence[] = []
  const hasChildIdentity = normalizeProviderTurnIdentity(input.event.toolAgentId) !== undefined

  if (input.event.currentTurnInventoryComplete === true) {
    if (input.event.currentTurnInventory === undefined) {
      return { evidence: [], ignored: 'incomplete-inventory' }
    }
    const inventory =
      input.event.currentTurnInventory === null
        ? null
        : providerCurrentTurnInventory(input.event.currentTurnInventory, true)
    if (input.event.currentTurnInventory !== null && inventory === null) {
      return { evidence: [], ignored: 'unsupported' }
    }
    evidence.push({
      source,
      producerId: `provider:${source}`,
      // Inventory is a complete snapshot, not a one-shot hook. Include its
      // contents in the dedupe identity so later child/background changes and
      // the eventual empty snapshot are not discarded as duplicates.
      eventId: providerTurnEventId(
        source,
        input.event.paneKey,
        name,
        inventory?.turnId,
        undefined,
        'event',
        undefined,
        JSON.stringify(inventory ?? null)
      ),
      observedAt,
      kind: 'current-turn-inventory',
      ...(inventory?.turnId ? { turnId: inventory.turnId } : {}),
      inventory: inventory ?? null
    })
  } else if (input.event.currentTurnInventory !== undefined) {
    return { evidence: [], ignored: 'incomplete-inventory' }
  }

  // A provider child can reuse the root event vocabulary (notably Claude's plain `Stop`).
  // Its agent id is the stronger attribution signal, so never let that event settle the root.
  if (!hasChildIdentity && TURN_START_EVENTS.has(name) && turnId) {
    evidence.push({
      source,
      producerId: `provider:${source}`,
      eventId: providerTurnEventId(source, input.event.paneKey, name, turnId, undefined),
      observedAt,
      kind: 'turn-started',
      turnId,
      recordKind: 'event'
    })
  }

  if (
    !hasChildIdentity &&
    TURN_OUTCOME_EVENTS.has(name) &&
    isTerminalTurnOutcome(source, name, input.event.providerTurnTerminal)
  ) {
    if (input.event.payload.sessionBoundary === true) {
      return { evidence, ignored: 'session-boundary' }
    }
    if (!turnId) {
      evidence.push(...readChildEvidence(input, observedAt, name, turnId))
      return { evidence, ignored: 'anonymous-outcome' }
    }
    const outcome = outcomeFor(name, input.event.payload)
    evidence.push({
      source,
      producerId: `provider:${source}`,
      eventId: providerTurnEventId(source, input.event.paneKey, name, turnId, outcome),
      observedAt,
      kind:
        INTERRUPT_EVENTS.has(name) || input.event.payload.interrupted === true
          ? 'turn-interrupt-acknowledged'
          : 'turn-outcome-observed',
      turnId,
      outcome,
      recordKind: 'event'
    })
  }

  evidence.push(...readChildEvidence(input, observedAt, name, turnId))
  return { evidence }
}

export function readProviderInterruptAcknowledgement(
  input: ProviderInterruptEvidenceInput
): ProviderTurnEvidenceRead {
  const turnId = normalizeProviderTurnIdentity(input.turnId)
  if (!turnId) {
    return { evidence: [], ignored: 'anonymous-outcome' }
  }
  const observedAt = input.observedAt ?? Date.now()
  return {
    evidence: [
      {
        source: input.source,
        producerId: `provider:${input.source}`,
        eventId: providerTurnEventId(
          input.source,
          input.paneKey,
          'interrupt_acknowledged',
          turnId,
          'interrupted',
          input.acknowledgedBy === 'provider-record' ? 'terminal-record' : 'event'
        ),
        observedAt,
        kind: 'turn-interrupt-acknowledged',
        turnId,
        outcome: 'interrupted',
        recordKind: input.acknowledgedBy === 'provider-record' ? 'terminal-record' : 'event'
      }
    ]
  }
}
