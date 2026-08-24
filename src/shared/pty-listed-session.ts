import type { ExecutionHostId } from './execution-host'

export const PTY_SESSION_INVENTORY_RETAINED_ID_LIMIT = 4096
/**
 * Whether an agent holds a listed session.
 *
 * `unknown` is not a variant of `absent`. A provider that cannot serialize claims — a legacy
 * daemon generation below the claim protocol, an older SSH relay, the in-process local fallback —
 * reports no owners for a session that may well have one. Only a provider whose
 * `providesAgentSessionOwnerListings` is true may make listing absence authoritative.
 */
export type AgentOwnershipEvidence = 'present' | 'absent' | 'unknown'

/**
 * One row of `pty:listSessions`. Shared so the main handler, both preload surfaces, and the
 * renderer cannot drift on which evidence the UI is allowed to see.
 */
export type PtyListedSession = {
  id: string
  cwd: string
  title: string
  /**
   * Agent ownership as the listing provider could establish it. Destructive actions must treat
   * anything other than `absent` as live work: discarding this distinction is what let Resource
   * Manager force-kill live agent sessions (#8459).
   */
  agentOwnership: AgentOwnershipEvidence
}

/**
 * Additive detailed inventory contract. Only `respondingHostIds` are
 * authoritative for pruning. `unavailableHostIds` includes retained ownership
 * scopes whose provider is currently unregistered after connection loss.
 */
export type PtySessionInventorySnapshot = {
  sessions: PtyListedSession[]
  hostIdBySessionId: Record<string, ExecutionHostId>
  queriedHostIds: ExecutionHostId[]
  /** Bounded last-known IDs for unavailable hosts, used by a cold renderer. */
  retainedSessionIdsByHost: Partial<Record<ExecutionHostId, string[]>>
  respondingHostIds: ExecutionHostId[]
  unavailableHostIds: ExecutionHostId[]
  complete: boolean
}

/** Only proven absence authorizes destroying a session without asking. */
export function mayDestroyWithoutOwnerEvidence(session: {
  agentOwnership: AgentOwnershipEvidence
}): boolean {
  return session.agentOwnership === 'absent'
}
