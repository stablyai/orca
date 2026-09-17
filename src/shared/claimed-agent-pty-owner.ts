import { randomUUID } from 'node:crypto'
import type {
  AgentSessionClaimedSpawnResult,
  AgentSessionExecutionClaim,
  AgentSessionOwnerBinding,
  AgentSessionSurfaceBinding
} from './agent-session-host-authority'
import {
  agentStatusExecutionBindingsEqual,
  agentSessionClaimKey,
  agentSessionClaimsEqual,
  agentSessionSurfacesEqual,
  buildClaimedAgentPtyOwnerIndex,
  cloneAgentSessionClaim,
  cloneAgentSessionOwner,
  cloneAgentSessionSurface,
  cloneAgentStatusExecutionBinding,
  countClaimedAgentPtyOwners,
  parseSpawnedAgentSessionOwner,
  prepareRegisteredAgentSessionOwner,
  reconcileClaimedAgentPtyOwnerSnapshot,
  scopedAgentSessionClaimsEqual,
  type LiveAgentSessionOwner
} from './claimed-agent-pty-owner-snapshot'
import type { AgentStatusExecutionBinding } from './agent-status-run'

export { agentSessionOwnerBindingsEqual } from './claimed-agent-pty-owner-snapshot'

export const MAX_CLAIMED_AGENT_PTY_OWNER_ENTRIES = 1024

type ReservedOwner = {
  claim: AgentSessionExecutionClaim
  worktreeScopeDigest: string
  generation: string
  phase: 'reserved'
  statusBinding: AgentStatusExecutionBinding
  promise: Promise<AgentSessionClaimedSpawnResult>
}

type LiveOwner = LiveAgentSessionOwner

function cloneClaim(claim: AgentSessionExecutionClaim): AgentSessionExecutionClaim {
  return cloneAgentSessionClaim(claim)
}

function cloneSurface(surface: AgentSessionSurfaceBinding): AgentSessionSurfaceBinding {
  return cloneAgentSessionSurface(surface)
}

function cloneOwner(owner: LiveOwner): LiveOwner {
  return cloneAgentSessionOwner(owner)
}

export class ClaimedAgentPtyOwnerRegistry {
  private readonly reserved = new Map<string, ReservedOwner>()
  private readonly live = new Map<string, LiveOwner>()
  private readonly conflicts = new Map<string, LiveOwner[]>()
  private keysByPtyId = new Map<string, Set<string>>()

  async ensure(args: {
    claim: AgentSessionExecutionClaim
    surface: AgentSessionSurfaceBinding
    spawn: (reservation: {
      generation: string
      statusBinding: AgentStatusExecutionBinding
    }) => Promise<{
      ptyId: string
      owner?: unknown
      disposition?: AgentSessionClaimedSpawnResult['disposition']
    }>
    isLive?: (owner: LiveAgentSessionOwner) => boolean | Promise<boolean>
  }): Promise<AgentSessionClaimedSpawnResult> {
    // Why: callers retain their request objects across retries; snapshot them so
    // mutation during an awaited liveness/spawn check cannot change registry keys.
    const requestedClaim = cloneClaim(args.claim)
    const requestedSurface = cloneSurface(args.surface)
    const key = agentSessionClaimKey(requestedClaim)
    if (this.conflicts.has(key)) {
      throw new Error('agent_session_conflict')
    }
    const live = this.live.get(key)
    let continuityOf: string | undefined
    if (live) {
      if (!agentSessionClaimsEqual(live.claim, requestedClaim)) {
        throw new Error('agent_session_ownership_unknown')
      }
      if (live.claim.worktreeScopeDigest !== requestedClaim.worktreeScopeDigest) {
        throw new Error('agent_session_conflict')
      }
      if (!args.isLive || (await args.isLive(cloneOwner(live)))) {
        const current = this.live.get(key)
        if (current?.ptyId === live.ptyId && current.generation === live.generation) {
          return { disposition: 'adopted', owner: cloneOwner(current) }
        }
        return await this.ensure(args)
      }
      continuityOf = live.statusBinding.runId
      this.release(live.ptyId, live.generation)
    }

    const reserved = this.reserved.get(key)
    if (reserved) {
      if (reserved.worktreeScopeDigest !== requestedClaim.worktreeScopeDigest) {
        throw new Error('agent_session_conflict')
      }
      const result = await reserved.promise
      return { disposition: 'adopted', owner: cloneOwner(result.owner as LiveOwner) }
    }

    this.assertCapacityForNewOwner()
    const generation = randomUUID()
    const statusBinding: AgentStatusExecutionBinding = {
      runId: randomUUID(),
      attachment: { executionId: randomUUID() },
      role: 'root',
      ...(continuityOf ? { continuityOf } : {})
    }
    let resolveReservation!: (result: AgentSessionClaimedSpawnResult) => void
    let rejectReservation!: (error: unknown) => void
    const promise = new Promise<AgentSessionClaimedSpawnResult>((resolve, reject) => {
      resolveReservation = resolve
      rejectReservation = reject
    })
    // Why: the creating caller receives the spawn error directly; keep a
    // no-join reservation rejection from becoming an unhandled promise.
    void promise.catch(() => {})
    this.reserved.set(key, {
      claim: requestedClaim,
      worktreeScopeDigest: requestedClaim.worktreeScopeDigest,
      generation,
      phase: 'reserved',
      statusBinding,
      promise
    })

    let promotedOwner: LiveOwner | null = null
    try {
      const spawned = await args.spawn({ generation, statusBinding })
      const canonicalOwner = parseSpawnedAgentSessionOwner(spawned.owner)
      const owner: LiveOwner = canonicalOwner
        ? {
            claim: cloneClaim(canonicalOwner.claim),
            generation: canonicalOwner.generation,
            phase: 'live',
            ptyId: canonicalOwner.ptyId,
            surface: cloneSurface(canonicalOwner.surface),
            statusBinding: cloneAgentStatusExecutionBinding(canonicalOwner.statusBinding)
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
        !spawned.owner &&
        (!agentSessionSurfacesEqual(owner.surface, requestedSurface) ||
          owner.generation !== generation ||
          !agentStatusExecutionBindingsEqual(owner.statusBinding, statusBinding))
      ) {
        // Why: a lower host owner is authoritative; without one, a fresh spawn
        // must retain this reservation's generation, surface, and status binding.
        throw new Error('agent_session_ownership_unknown')
      }
      const reservation = this.reserved.get(key)
      if (reservation?.generation !== generation) {
        throw new Error('agent_session_ownership_unknown')
      }
      this.live.set(key, owner)
      const keys = this.keysByPtyId.get(owner.ptyId) ?? new Set<string>()
      keys.add(key)
      this.keysByPtyId.set(owner.ptyId, keys)
      promotedOwner = owner
      // Why: exit can beat spawn completion. Index before the awaited proof so
      // a generation-matched exit can remove this owner instead of being lost.
      if (args.isLive && !(await args.isLive(cloneOwner(owner)))) {
        throw new Error('agent_session_exited_during_start')
      }
      const current = this.live.get(key)
      if (current?.ptyId !== owner.ptyId || current.generation !== owner.generation) {
        throw new Error('agent_session_exited_during_start')
      }
      const result: AgentSessionClaimedSpawnResult = {
        disposition: spawned.disposition ?? 'created',
        owner: cloneOwner(owner)
      }
      resolveReservation(result)
      return result
    } catch (error) {
      if (promotedOwner) {
        this.release(promotedOwner.ptyId, promotedOwner.generation)
      }
      rejectReservation(error)
      throw error
    } finally {
      const current = this.reserved.get(key)
      if (current?.generation === generation) {
        this.reserved.delete(key)
      }
    }
  }

  register(owner: AgentSessionOwnerBinding): void {
    const key = agentSessionClaimKey(owner.claim)
    const registered = prepareRegisteredAgentSessionOwner({
      owner,
      existing: this.live.get(key),
      reserved: this.reserved.has(key),
      conflicted: this.conflicts.has(key)
    })
    if (!registered) {
      return
    }
    this.assertCapacityForNewOwner()
    this.live.set(key, registered)
    const keys = this.keysByPtyId.get(owner.ptyId) ?? new Set<string>()
    keys.add(key)
    this.keysByPtyId.set(owner.ptyId, keys)
  }

  reconcileAuthoritative(
    owners: readonly AgentSessionOwnerBinding[],
    opts: { isInAuthoritativeScope?: (owner: AgentSessionOwnerBinding) => boolean } = {}
  ): void {
    if (owners.length > MAX_CLAIMED_AGENT_PTY_OWNER_ENTRIES) {
      throw new Error('execution_owner_unavailable')
    }
    const next = reconcileClaimedAgentPtyOwnerSnapshot({
      live: this.live,
      conflicts: this.conflicts,
      reservedKeys: new Set(this.reserved.keys()),
      incoming: owners,
      isInAuthoritativeScope: opts.isInAuthoritativeScope ?? (() => true)
    })
    if (
      this.countOwners(next.live, next.conflicts) + this.reserved.size >
      MAX_CLAIMED_AGENT_PTY_OWNER_ENTRIES
    ) {
      throw new Error('execution_owner_unavailable')
    }

    // Why: recovery decisions must observe one complete provider snapshot;
    // mutating only after validation prevents first-provider residue on conflict.
    this.live.clear()
    this.conflicts.clear()
    for (const [key, owner] of next.live) {
      this.live.set(key, owner)
    }
    for (const [key, conflict] of next.conflicts) {
      this.conflicts.set(key, conflict)
    }
    this.rebuildPtyIndex()
  }

  release(ptyId: string, generation?: string): void {
    const keys = this.keysByPtyId.get(ptyId)
    if (!keys) {
      return
    }
    for (const key of keys) {
      const owner = this.live.get(key)
      if (!owner || (generation !== undefined && owner.generation !== generation)) {
        continue
      }
      this.live.delete(key)
    }
    for (const [key, conflict] of this.conflicts) {
      const remaining = conflict.filter(
        (owner) =>
          owner.ptyId !== ptyId || (generation !== undefined && owner.generation !== generation)
      )
      if (remaining.length === 0) {
        this.conflicts.delete(key)
      } else if (remaining.length === 1) {
        this.conflicts.delete(key)
        this.live.set(key, remaining[0])
      } else {
        this.conflicts.set(key, remaining)
      }
    }
    this.rebuildPtyIndex()
  }

  list(): AgentSessionOwnerBinding[] {
    return [...this.live.values()].map(cloneOwner)
  }

  listForPty(ptyId: string): AgentSessionOwnerBinding[] {
    const keys = this.keysByPtyId.get(ptyId)
    if (!keys) {
      return []
    }
    return [...keys]
      .map((key) => this.live.get(key))
      .filter((owner): owner is LiveOwner => owner !== undefined)
      .map(cloneOwner)
  }

  find(claim: AgentSessionExecutionClaim): AgentSessionOwnerBinding | null {
    const owner = this.live.get(agentSessionClaimKey(claim))
    return owner && scopedAgentSessionClaimsEqual(owner.claim, claim) ? cloneOwner(owner) : null
  }

  private rebuildPtyIndex(): void {
    this.keysByPtyId = buildClaimedAgentPtyOwnerIndex(this.live, this.conflicts)
  }

  private assertCapacityForNewOwner(): void {
    if (
      this.countOwners(this.live, this.conflicts) + this.reserved.size >=
      MAX_CLAIMED_AGENT_PTY_OWNER_ENTRIES
    ) {
      throw new Error('execution_owner_unavailable')
    }
  }

  private countOwners(
    live: ReadonlyMap<string, LiveOwner>,
    conflicts: ReadonlyMap<string, readonly LiveOwner[]>
  ): number {
    return countClaimedAgentPtyOwners(live, conflicts)
  }
}
