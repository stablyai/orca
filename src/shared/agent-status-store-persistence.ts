import type { AgentStatusStoreSnapshot } from './agent-status-store-contract'
import { parseAgentStatusStoreSnapshot } from './agent-status-store-codec'
import { assertJsonTextStructureWithinLimits } from './json-text-structure-limit'

const SNAPSHOT_NESTING_DEPTH = 32

/** Persistence form; callers write the returned string with their existing owner. */
export function serializeAgentStatusStoreSnapshot(snapshot: AgentStatusStoreSnapshot): string {
  const parsed = parseAgentStatusStoreSnapshot(snapshot)
  if (!parsed) {
    throw new Error('Invalid agent status store snapshot')
  }
  return JSON.stringify(parsed)
}

export function deserializeAgentStatusStoreSnapshot(
  serialized: string
): AgentStatusStoreSnapshot | null {
  try {
    // Size follows the store, which its owners' lifetimes bound; only nesting is limited here.
    assertJsonTextStructureWithinLimits(serialized, {
      structuralTokens: serialized.length,
      nestingDepth: SNAPSHOT_NESTING_DEPTH
    })
    return parseAgentStatusStoreSnapshot(JSON.parse(serialized))
  } catch {
    return null
  }
}
