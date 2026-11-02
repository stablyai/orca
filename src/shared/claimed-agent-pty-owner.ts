import type { PtyCreationDisposition } from './pty-creation-disposition'
export type { PtyCreationDisposition } from './pty-creation-disposition'
import { randomUUID } from 'node:crypto'
import type {
  AgentSessionClaimedSpawnResult,
  AgentSessionExecutionClaim,
  AgentSessionOwnerBinding,
  AgentSessionSurfaceBinding
} from './agent-session/agent-session-host-authority'
import {
  agentSessionClaimKey,
  agentSessionClaimsEqual,
  buildClaimedAgentPtyOwnerIndex,
  cloneAgentSessionClaim,
  cloneAgentSessionOwner,
  cloneAgentSessionSurface,
  prepareRegisteredAgentSessionOwner,
  reconcileClaimedAgentPtyOwnerSnapshot,
  scopedAgentSessionClaimsEqual,
  type LiveAgentSessionOwner
} from './claimed-agent-pty-owner-snapshot'

import {
  countClaimedAgentPtyOwners,
  isExactlyReleasableOwner,
  pruneAdoptionMarkers,
  releaseClaimedAgentPtyOwners,
  spawnedAgentSessionOwner
} from './claimed-agent-pty-owner-entries'

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
  // Generation-scoped and in memory: an adopted owner's opening must not change underneath it.
  private readonly adoptedGenerations = new Map<string, string>()
  private readonly adoptionListeners = new Set<(owner: AgentSessionOwnerBinding) => void>()

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
    exitedDuringStart?: () => Error
    /** Reservations this request already waited on, whose owner has since been released. */
    skipReservation?: ReadonlySet<object>
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
          return this.adopt(key, current)
        }
        return await this.ensure(args)
      }
      this.release(live.ptyId, live.generation)
    }

    const reserved = this.reserved.get(key)
    if (reserved && !args.skipReservation?.has(reserved)) {
      if (reserved.worktreeScopeDigest !== requestedClaim.worktreeScopeDigest) {
        throw new Error('agent_session_conflict')
      }
      args.onJoin?.(reserved.creation)
      const result = await reserved.promise
      // The owner may have been released while this request waited; adopt only what is current.
      const current = this.live.get(key)
      if (current?.ptyId === result.owner.ptyId && current.generation === result.owner.generation) {
        return this.adopt(key, current)
      }
      // A start still settling its reservation cannot be joined again; this request starts its own.
      return await this.ensure({
        ...args,
        skipReservation: new Set([...(args.skipReservation ?? []), reserved])
      })
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
      const owner = spawnedAgentSessionOwner(spawned, requestedClaim, requestedSurface, generation)
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
        throw args.exitedDuringStart?.() ?? new Error('agent_session_exited_during_start')
      }
      const current = this.live.get(key)
      if (current?.ptyId !== owner.ptyId || current.generation !== owner.generation) {
        throw args.exitedDuringStart?.() ?? new Error('agent_session_exited_during_start')
      }
      const result: AgentSessionClaimedSpawnResult =
        spawned.disposition === 'adopted'
          ? this.adopt(key, owner)
          : { disposition: 'created', owner: cloneOwner(owner) }
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
      countClaimedAgentPtyOwners(next.live, next.conflicts) + this.reserved.size >
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
    if (keys) {
      releaseClaimedAgentPtyOwners(this.live, this.conflicts, keys, ptyId, generation)
      this.rebuildPtyIndex()
    }
  }

  /** Removes exactly this binding: same claim, generation and PTY. `refused` when another owner,
   *  a pending start or an adoption of this generation holds the claim; `absent` when none does. */
  releaseExact(owner: AgentSessionOwnerBinding): 'released' | 'absent' | 'refused' {
    const key = agentSessionClaimKey(owner.claim)
    const live = this.live.get(key)
    if (this.reserved.has(key) || this.conflicts.has(key)) {
      return 'refused'
    }
    if (!live) {
      return 'absent'
    }
    if (!isExactlyReleasableOwner(live, owner, this.adoptedGenerations.get(key))) {
      return 'refused'
    }
    this.live.delete(key)
    this.rebuildPtyIndex()
    return 'released'
  }

  wasAdopted(owner: AgentSessionOwnerBinding): boolean {
    return this.adoptedGenerations.get(agentSessionClaimKey(owner.claim)) === owner.generation
  }

  /** Runs synchronously before an adopted owner is returned to its requester. */
  onAdopted(listener: (owner: AgentSessionOwnerBinding) => void): () => void {
    this.adoptionListeners.add(listener)
    return () => this.adoptionListeners.delete(listener)
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

  private adopt(key: string, owner: LiveOwner): AgentSessionClaimedSpawnResult {
    this.adoptedGenerations.set(key, owner.generation)
    for (const listener of this.adoptionListeners) {
      listener(cloneOwner(owner))
    }
    return { disposition: 'adopted', owner: cloneOwner(owner) }
  }

  private rebuildPtyIndex(): void {
    this.keysByPtyId = buildClaimedAgentPtyOwnerIndex(this.live, this.conflicts)
    pruneAdoptionMarkers(this.adoptedGenerations, this.live)
  }

  private assertCapacityForNewOwner(): void {
    if (
      countClaimedAgentPtyOwners(this.live, this.conflicts) + this.reserved.size >=
      MAX_CLAIMED_AGENT_PTY_OWNER_ENTRIES
    ) {
      throw new Error('execution_owner_unavailable')
    }
  }
}
