import type { AgentStatusExecutionBinding } from './agent-status-execution-binding'
import {
  agentSessionSurfacesEqual,
  cloneAgentSessionClaim,
  cloneAgentSessionSurface,
  cloneAgentStatusExecutionBinding,
  parseSpawnedAgentSessionOwner,
  scopedAgentSessionClaimsEqual,
  type LiveAgentSessionOwner
} from './claimed-agent-pty-owner-snapshot'
import type {
  AgentSessionClaimedSpawnResult,
  AgentSessionExecutionClaim,
  AgentSessionSurfaceBinding
} from './agent-session-host-authority'

/**
 * Turns one spawn result into the live owner a reservation promotes to, and refuses any result
 * that does not agree with what was reserved. Kept apart from the registry so the reservation
 * bookkeeping and the authority decision can be read, and tested, separately.
 */
export function promoteSpawnedAgentSessionOwner(args: {
  spawned: {
    ptyId: string
    owner?: unknown
    disposition?: AgentSessionClaimedSpawnResult['disposition']
  }
  requestedClaim: AgentSessionExecutionClaim
  requestedSurface: AgentSessionSurfaceBinding
  generation: string
  statusBinding: AgentStatusExecutionBinding
}): LiveAgentSessionOwner {
  const { spawned, requestedClaim, requestedSurface, generation, statusBinding } = args
  const canonicalOwner = parseSpawnedAgentSessionOwner(spawned.owner)
  const owner: LiveAgentSessionOwner = canonicalOwner
    ? {
        claim: cloneAgentSessionClaim(canonicalOwner.claim),
        generation: canonicalOwner.generation,
        phase: 'live',
        ptyId: canonicalOwner.ptyId,
        surface: cloneAgentSessionSurface(canonicalOwner.surface),
        // Why the fallback: for a fresh create this host minted the binding and stamped it into
        // the spawn env before the lower host ran, so it stays authoritative even when a lower
        // host that predates run identity echoes an owner without one. An adopted owner keeps
        // whatever the lower host actually holds, including nothing.
        ...(canonicalOwner.statusBinding
          ? { statusBinding: cloneAgentStatusExecutionBinding(canonicalOwner.statusBinding) }
          : spawned.disposition === 'adopted'
            ? {}
            : { statusBinding })
      }
    : {
        claim: requestedClaim,
        generation,
        phase: 'live',
        ptyId: spawned.ptyId,
        surface: requestedSurface,
        statusBinding
      }
  if (
    owner.ptyId !== spawned.ptyId ||
    !scopedAgentSessionClaimsEqual(owner.claim, requestedClaim)
  ) {
    throw new Error('agent_session_ownership_unknown')
  }
  if (
    canonicalOwner &&
    spawned.disposition !== 'adopted' &&
    !agentSessionSurfacesEqual(canonicalOwner.surface, requestedSurface)
  ) {
    // Why: only an already-reconciled owner may override placement; a fresh owner returning
    // another surface would let a lower layer forge authority. This must test what the lower host
    // returned — comparing the locally built owner against the request compares a literal with
    // itself, which cannot fail.
    throw new Error('agent_session_ownership_unknown')
  }
  return owner
}
