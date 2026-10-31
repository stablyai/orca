import type { AgentSessionExecutionClaim } from './agent-session-host-authority'
import {
  agentSessionClaimKey,
  agentSessionClaimsEqual,
  type LiveAgentSessionOwner
} from './claimed-agent-pty-owner-snapshot'

export const MAX_CLAIMED_AGENT_PTY_OWNER_ENTRIES = 1024

/** A claimed create's decision before anything is reserved, released or spawned. */
export type ClaimedAgentPtyOwnerDecision<Reserved> =
  | { kind: 'check' | 'adopt'; owner: LiveAgentSessionOwner }
  | { kind: 'join'; reserved: Reserved }
  | { kind: 'create' }

export type ClaimedAgentPtyOwnerState<Reserved> = {
  live: ReadonlyMap<string, LiveAgentSessionOwner>
  conflicts: ReadonlyMap<string, readonly LiveAgentSessionOwner[]>
  reserved: ReadonlyMap<string, Reserved>
}

function sameOwner(left: LiveAgentSessionOwner, right: LiveAgentSessionOwner | undefined) {
  return right?.ptyId === left.ptyId && right.generation === left.generation
}

export function countClaimedAgentPtyOwners(
  live: ReadonlyMap<string, LiveAgentSessionOwner>,
  conflicts: ReadonlyMap<string, readonly LiveAgentSessionOwner[]>
): number {
  let count = live.size
  for (const owners of conflicts.values()) {
    count += owners.length
  }
  return count
}

export function assertClaimedAgentPtyOwnerCapacity(
  state: ClaimedAgentPtyOwnerState<unknown>,
  freed = 0
): void {
  if (
    countClaimedAgentPtyOwners(state.live, state.conflicts) + state.reserved.size - freed >=
    MAX_CLAIMED_AGENT_PTY_OWNER_ENTRIES
  ) {
    throw new Error('execution_owner_unavailable')
  }
}

/**
 * The one ownership decision a claimed create acts on, and a switch asks before it stops anything:
 * refuse (throws), check a live owner's liveness, adopt one `proven` live, join the same-scope
 * create in flight, or create. A `dead` owner still listed reads as gone, its entry freed.
 */
export function decideClaimedAgentPtyOwner<Reserved extends { worktreeScopeDigest: string }>(
  state: ClaimedAgentPtyOwnerState<Reserved>,
  claim: AgentSessionExecutionClaim,
  seen: { proven?: LiveAgentSessionOwner; dead?: LiveAgentSessionOwner } = {}
): ClaimedAgentPtyOwnerDecision<Reserved> {
  const key = agentSessionClaimKey(claim)
  if (state.conflicts.has(key)) {
    throw new Error('agent_session_conflict')
  }
  const live = state.live.get(key)
  if (live && !sameOwner(live, seen.dead)) {
    if (!agentSessionClaimsEqual(live.claim, claim)) {
      throw new Error('agent_session_ownership_unknown')
    }
    if (live.claim.worktreeScopeDigest !== claim.worktreeScopeDigest) {
      throw new Error('agent_session_conflict')
    }
    return { kind: sameOwner(live, seen.proven) ? 'adopt' : 'check', owner: live }
  }
  const reserved = state.reserved.get(key)
  if (reserved) {
    if (reserved.worktreeScopeDigest !== claim.worktreeScopeDigest) {
      throw new Error('agent_session_conflict')
    }
    return { kind: 'join', reserved }
  }
  assertClaimedAgentPtyOwnerCapacity(state, live ? 1 : 0)
  return { kind: 'create' }
}
