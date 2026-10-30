import type { PtyCreationDisposition } from './pty-creation-disposition'
export type { PtyCreationDisposition } from './pty-creation-disposition'
import { randomUUID } from 'node:crypto'
import type {
  AgentSessionClaimedSpawnResult,
  AgentSessionExecutionClaim,
  AgentSessionOwnerBinding,
  AgentSessionSurfaceBinding
} from './agent-session-host-authority'
import {
  agentSessionClaimKey,
  agentSessionClaimsEqual,
  agentSessionSurfacesEqual,
  buildClaimedAgentPtyOwnerIndex,
  cloneAgentSessionClaim,
  cloneAgentSessionOwner,
  cloneAgentSessionSurface,
  prepareRegisteredAgentSessionOwner,
  reconcileClaimedAgentPtyOwnerSnapshot,
  scopedAgentSessionClaimsEqual,
  type LiveAgentSessionOwner
} from './claimed-agent-pty-owner-snapshot'

export { agentSessionOwnerBindingsEqual } from './claimed-agent-pty-owner-snapshot'

export const MAX_CLAIMED_AGENT_PTY_OWNER_ENTRIES = 1024

type ReservedOwner = {
  claim: AgentSessionExecutionClaim
  worktreeScopeDigest: string
  generation: string
  phase: 'reserved'
  promise: Promise<AgentSessionClaimedSpawnResult>
  creation?: Promise<PtyCreationDisposition>
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
    spawn: (reservation: { generation: string }) => Promise<{
      ptyId: string
      owner?: AgentSessionOwnerBinding
      disposition?: AgentSessionClaimedSpawnResult['disposition']
    }>
    isLive?: (owner: LiveAgentSessionOwner) => boolean | Promise<boolean>
    /** Called when this request waits on another request's start instead of starting its own. */
    onJoin?: (creation?: Promise<PtyCreationDisposition>) => void
    creation?: Promise<PtyCreationDisposition>
  }): Promise<AgentSessionClaimedSpawnResult> {
    // Snapshot reused retry arguments before awaits so caller mutations cannot change registry keys.
    const requestedClaim = cloneClaim(args.claim)
    const requestedSurface = cloneSurface(args.surface)
    const key = agentSessionClaimKey(requestedClaim)
    if (this.conflicts.has(key)) {
      throw new Error('agent_session_conflict')
    }
    const live = this.live.get(key)
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
      this.release(live.ptyId, live.generation)
    }

    const reserved = this.reserved.get(key)
    if (reserved) {
      if (reserved.worktreeScopeDigest !== requestedClaim.worktreeScopeDigest) {
        throw new Error('agent_session_conflict')
      }
      args.onJoin?.(reserved.creation)
      const result = await reserved.promise
      return { disposition: 'adopted', owner: cloneOwner(result.owner as LiveOwner) }
    }

    this.assertCapacityForNewOwner()
    const generation = randomUUID()
    let resolveReservation!: (result: AgentSessionClaimedSpawnResult) => void
    let rejectReservation!: (error: unknown) => void
    const promise = new Promise<AgentSessionClaimedSpawnResult>((resolve, reject) => {
      resolveReservation = resolve
      rejectReservation = reject
    })
    // The creator receives spawn errors directly; handle reservation rejection even without joiners.
    void promise.catch(() => {})
    this.reserved.set(key, {
      claim: requestedClaim,
      worktreeScopeDigest: requestedClaim.worktreeScopeDigest,
      generation,
      phase: 'reserved',
      creation: args.creation,
      promise
    })

    let published = false
    try {
      const spawned = await args.spawn({ generation })
      const owner: LiveOwner = spawned.owner
        ? {
            claim: cloneClaim(spawned.owner.claim),
            generation: spawned.owner.generation,
            phase: 'live',
            ptyId: spawned.owner.ptyId,
            surface: cloneSurface(spawned.owner.surface)
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
      const reservation = this.reserved.get(key)
      if (reservation?.generation !== generation) {
        throw new Error('agent_session_ownership_unknown')
      }
      this.live.set(key, owner)
      const keys = this.keysByPtyId.get(owner.ptyId) ?? new Set<string>()
      keys.add(key)
      this.keysByPtyId.set(owner.ptyId, keys)
      // Index before awaited proof so an exit beating spawn completion can remove the matching generation.
      if (args.isLive && !(await args.isLive(cloneOwner(owner)))) {
        this.release(owner.ptyId, owner.generation)
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
      published = true
      return result
    } catch (error) {
      rejectReservation(error)
      throw error
    } finally {
      const finish = () => {
        if (this.reserved.get(key)?.generation === generation) {
          this.reserved.delete(key)
        }
      }
      if (published || !args.creation) {
        finish()
      } else {
        void args.creation.then(async (disposition) => {
          if (disposition.kind === 'unknown') {
            return
          }
          if (disposition.kind === 'physical' || disposition.kind === 'failed') {
            await disposition.completion
          }
          finish()
        })
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

    // Validate a complete provider snapshot before mutation so conflicts leave no partial provider state.
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
    let count = live.size
    for (const owners of conflicts.values()) {
      count += owners.length
    }
    return count
  }
}
