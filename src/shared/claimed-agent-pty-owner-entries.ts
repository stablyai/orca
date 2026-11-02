import type {
  AgentSessionClaimedSpawnResult,
  AgentSessionExecutionClaim,
  AgentSessionOwnerBinding,
  AgentSessionSurfaceBinding
} from './agent-session/agent-session-host-authority'
import {
  agentSessionSurfacesEqual,
  cloneAgentSessionClaim,
  cloneAgentSessionSurface,
  scopedAgentSessionClaimsEqual,
  type LiveAgentSessionOwner
} from './claimed-agent-pty-owner-snapshot'

type Owners = Map<string, LiveAgentSessionOwner>
type Conflicts = Map<string, LiveAgentSessionOwner[]>

/** Drops every binding of a PTY, or only its `generation`; a conflict left with one owner resolves to it. */
export function releaseClaimedAgentPtyOwners(
  live: Owners,
  conflicts: Conflicts,
  keys: ReadonlySet<string>,
  ptyId: string,
  generation: string | undefined
): void {
  for (const key of keys) {
    const owner = live.get(key)
    if (owner && (generation === undefined || owner.generation === generation)) {
      live.delete(key)
    }
  }
  for (const [key, conflict] of conflicts) {
    const remaining = conflict.filter(
      (owner) =>
        owner.ptyId !== ptyId || (generation !== undefined && owner.generation !== generation)
    )
    conflicts.delete(key)
    if (remaining.length === 1) {
      live.set(key, remaining[0])
    } else if (remaining.length > 1) {
      conflicts.set(key, remaining)
    }
  }
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

/** Whether `current` is exactly the binding a release names and no adoption of it has happened. */
export function isExactlyReleasableOwner(
  current: LiveAgentSessionOwner,
  owner: AgentSessionOwnerBinding,
  adoptedGeneration: string | undefined
): boolean {
  return (
    current.ptyId === owner.ptyId &&
    current.generation === owner.generation &&
    scopedAgentSessionClaimsEqual(current.claim, owner.claim) &&
    adoptedGeneration !== owner.generation
  )
}

/** An adoption marker dies with the binding it marked. */
export function pruneAdoptionMarkers(adopted: Map<string, string>, live: Owners): void {
  for (const [key, generation] of adopted) {
    if (live.get(key)?.generation !== generation) {
      adopted.delete(key)
    }
  }
}

/** The live owner a start produced; only a reconciled (adopted) owner may name another surface. */
export function spawnedAgentSessionOwner(
  spawned: {
    ptyId: string
    owner?: AgentSessionOwnerBinding
    disposition?: AgentSessionClaimedSpawnResult['disposition']
  },
  requestedClaim: AgentSessionExecutionClaim,
  requestedSurface: AgentSessionSurfaceBinding,
  generation: string
): LiveAgentSessionOwner {
  const owner: LiveAgentSessionOwner = spawned.owner
    ? {
        claim: cloneAgentSessionClaim(spawned.owner.claim),
        generation: spawned.owner.generation,
        phase: 'live',
        ptyId: spawned.owner.ptyId,
        surface: cloneAgentSessionSurface(spawned.owner.surface)
      }
    : {
        claim: requestedClaim,
        generation,
        phase: 'live',
        ptyId: spawned.ptyId,
        surface: requestedSurface
      }
  if (
    owner.ptyId !== spawned.ptyId ||
    !scopedAgentSessionClaimsEqual(owner.claim, requestedClaim)
  ) {
    throw new Error('agent_session_ownership_unknown')
  }
  if (
    spawned.disposition !== 'adopted' &&
    !agentSessionSurfacesEqual(owner.surface, requestedSurface)
  ) {
    // Only reconciled owners may override placement; a fresh owner cannot forge another surface’s authority.
    throw new Error('agent_session_ownership_unknown')
  }
  return owner
}
