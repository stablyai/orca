import type {
  AgentStatusStoreMutation,
  AgentStatusStoreSnapshot
} from './agent-status-store-contract'
import {
  isAgentStatusStoreEpoch,
  parseAgentStatusStoreMutation,
  parseAgentStatusStoreSnapshot
} from './agent-status-store-codec'
import { assertJsonTextStructureWithinLimits } from './json-text-structure-limit'

// Why: the store has no size limit, so only nesting is bounded; any envelope it can serialize must parse.
const ENVELOPE_STRUCTURE_LIMITS = {
  structuralTokens: Number.MAX_SAFE_INTEGER,
  nestingDepth: 40
} as const

export type AgentStatusSnapshotEnvelope = {
  type: 'snapshot'
  snapshot: AgentStatusStoreSnapshot
}

export type AgentStatusMutationEnvelope = {
  type: 'mutation'
  epoch: string
  previousRevision: number
  revision: number
  mutation: AgentStatusStoreMutation
}

export type AgentStatusTransportEnvelope = AgentStatusSnapshotEnvelope | AgentStatusMutationEnvelope

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(record)
  return keys.length === expected.length && keys.every((key) => expected.includes(key))
}

function isRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

export function parseAgentStatusTransportEnvelope(
  value: unknown
): AgentStatusTransportEnvelope | null {
  if (!isRecord(value)) {
    return null
  }
  if (value.type === 'snapshot' && hasExactKeys(value, ['type', 'snapshot'])) {
    const snapshot = parseAgentStatusStoreSnapshot(value.snapshot)
    return snapshot ? { type: 'snapshot', snapshot } : null
  }
  if (
    value.type !== 'mutation' ||
    !hasExactKeys(value, ['type', 'epoch', 'previousRevision', 'revision', 'mutation']) ||
    !isAgentStatusStoreEpoch(value.epoch) ||
    !isRevision(value.previousRevision) ||
    !isRevision(value.revision) ||
    value.revision !== value.previousRevision + 1
  ) {
    return null
  }
  const mutation = parseAgentStatusStoreMutation(value.mutation)
  return mutation
    ? {
        type: 'mutation',
        epoch: value.epoch,
        previousRevision: value.previousRevision,
        revision: value.revision,
        mutation
      }
    : null
}

export function serializeAgentStatusTransportEnvelope(
  envelope: AgentStatusTransportEnvelope
): string {
  const parsed = parseAgentStatusTransportEnvelope(envelope)
  if (!parsed) {
    throw new Error('Invalid agent status transport envelope')
  }
  return JSON.stringify(parsed)
}

export function deserializeAgentStatusTransportEnvelope(
  serialized: string
): AgentStatusTransportEnvelope | null {
  try {
    assertJsonTextStructureWithinLimits(serialized, ENVELOPE_STRUCTURE_LIMITS)
    return parseAgentStatusTransportEnvelope(JSON.parse(serialized))
  } catch {
    return null
  }
}
