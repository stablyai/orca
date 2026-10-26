import type { AgentType } from './agent-status-types'
import type { SessionOptionValue } from './native-chat-session-options'
import type { TrackedNativeChatSessionOption } from './native-chat-session-option-state'

/** Independent host-held values need no model parent. Mutate the record in place so session identity stays stable across picker fences. */
export type StructuredAgentSessionOptionRecord = {
  agent: AgentType
  values: Record<string, TrackedNativeChatSessionOption>
}

const ANSWERED_VALUE_IDS = ['model', 'effort', 'fastMode', 'serviceTier'] as const

export function createStructuredAgentSessionOptionRecord(
  agent: AgentType
): StructuredAgentSessionOptionRecord {
  return { agent, values: {} }
}

export function cloneStructuredAgentSessionOptionRecord(
  record: StructuredAgentSessionOptionRecord
): StructuredAgentSessionOptionRecord {
  return {
    agent: record.agent,
    values: Object.fromEntries(
      Object.entries(record.values).map(([id, tracked]) => [id, { ...tracked }])
    )
  }
}

/** The chat's model id, its own or (with `any`) one a catalog supplied in its place. */
export function structuredAgentSessionModelId(
  record: StructuredAgentSessionOptionRecord,
  provenance: 'own' | 'any'
): string | null {
  const tracked = record.values.model
  return typeof tracked?.value === 'string' &&
    (provenance === 'any' || tracked.source !== 'default')
    ? tracked.value
    : null
}

/** A value the chat holds as its own; a catalog default only fills the picker in. */
export function structuredAgentSessionOwnValue(
  record: StructuredAgentSessionOptionRecord,
  id: string
): string | undefined {
  const tracked = record.values[id]
  return tracked?.source !== 'default' && typeof tracked?.value === 'string' && tracked.value
    ? tracked.value
    : undefined
}

/** A complete answer replaces each value it speaks for; one naming no model leaves the model. */
export function replaceStructuredAgentSessionAnsweredValues(
  record: StructuredAgentSessionOptionRecord,
  answered: Readonly<Partial<Record<(typeof ANSWERED_VALUE_IDS)[number], SessionOptionValue>>>,
  sourceFor: (id: string) => TrackedNativeChatSessionOption['source']
): void {
  for (const id of ANSWERED_VALUE_IDS) {
    const value = answered[id]
    if (value !== undefined) {
      record.values[id] = { value, source: sourceFor(id) }
    } else if (id !== 'model') {
      delete record.values[id]
    }
  }
}
