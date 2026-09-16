import {
  AGENT_STATUS_STORE_LIMITS,
  type AgentStatusStoreSnapshot
} from './agent-status-store-contract'
import { parseAgentStatusStoreSnapshot } from './agent-status-store-codec'
import { assertJsonTextStructureWithinLimits } from './json-text-structure-limit'
import { measureUtf8ByteLength } from './utf8-byte-limits'

const SNAPSHOT_STRUCTURE_LIMITS = {
  structuralTokens: 512 * 1024,
  nestingDepth: 32
} as const

function isWithinByteLimit(value: string): boolean {
  return !measureUtf8ByteLength(value, {
    stopAfterBytes: AGENT_STATUS_STORE_LIMITS.serializedBytes
  }).exceededLimit
}

/** Bounded persistence form; callers write the returned string with their existing owner. */
export function serializeAgentStatusStoreSnapshot(snapshot: AgentStatusStoreSnapshot): string {
  const parsed = parseAgentStatusStoreSnapshot(snapshot)
  if (!parsed) {
    throw new Error('Invalid agent status store snapshot')
  }
  const serialized = JSON.stringify(parsed)
  if (!isWithinByteLimit(serialized)) {
    throw new Error('Agent status store snapshot exceeds its serialized-byte limit')
  }
  return serialized
}

export function deserializeAgentStatusStoreSnapshot(
  serialized: string
): AgentStatusStoreSnapshot | null {
  if (!isWithinByteLimit(serialized)) {
    return null
  }
  try {
    assertJsonTextStructureWithinLimits(serialized, SNAPSHOT_STRUCTURE_LIMITS)
    return parseAgentStatusStoreSnapshot(JSON.parse(serialized))
  } catch {
    return null
  }
}
