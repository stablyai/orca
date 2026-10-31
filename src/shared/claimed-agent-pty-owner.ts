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
  assertClaimedAgentPtyOwnerCapacity,
  countClaimedAgentPtyOwners,
  decideClaimedAgentPtyOwner,
  MAX_CLAIMED_AGENT_PTY_OWNER_ENTRIES
} from './claimed-agent-pty-owner-decision'
import {
  agentSessionClaimKey,
  agentSessionSurfacesEqual,
  buildClaimedAgentPtyOwnerIndex,
  cloneAgentSessionClaim as cloneClaim,
  cloneAgentSessionOwner as cloneOwner,
  cloneAgentSessionSurface as cloneSurface,
  prepareRegisteredAgentSessionOwner,
  reconcileClaimedAgentPtyOwnerSnapshot,
  scopedAgentSessionClaimsEqual,
  type LiveAgentSessionOwner
} from './claimed-agent-pty-owner-snapshot'

export { agentSessionOwnerBindingsEqual } from './claimed-agent-pty-owner-snapshot'

export { MAX_CLAIMED_AGENT_PTY_OWNER_ENTRIES } from './claimed-agent-pty-owner-decision'

type ReservedOwner = {
  claim: AgentSessionExecutionClaim
  worktreeScopeDigest: string
  generation: string
  phase: 'reserved'
  promise: Promise<AgentSessionClaimedSpawnResult>
  creation?: Promise<PtyCreationDisposition>
}

type LiveOwner = LiveAgentSessionOwner

export class ClaimedAgentPtyOwnerRegistry {
  private readonly reserved = new Map<string, ReservedOwner>()
  private readonly live = new Map<string, LiveOwner>()
  private readonly conflicts = new Map<string, LiveOwner[]>()
  private readonly state = { reserved: this.reserved, live: this.live, conflicts: this.conflicts }
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
    exitedDuringStart?: () => Error
  }): Promise<AgentSessionClaimedSpawnResult> {
    // Snapshot reused retry arguments before awaits so caller mutations cannot change registry keys.
    const requestedClaim = cloneClaim(args.claim)
    const requestedSurface = cloneSurface(args.surface)
    const key = agentSessionClaimKey(requestedClaim)
    // Decided again after each awaited proof; acting on it stays synchronous with the decision.
    let decision = decideClaimedAgentPtyOwner(this.state, requestedClaim)
    while (decision.kind === 'check') {
      const owner = decision.owner
      if (!args.isLive || (await args.isLive(cloneOwner(owner)))) {
        decision = decideClaimedAgentPtyOwner(this.state, requestedClaim, { proven: owner })
      } else {
        this.release(owner.ptyId, owner.generation)
        decision = decideClaimedAgentPtyOwner(this.state, requestedClaim, { dead: owner })
      }
    }
    if (decision.kind === 'adopt') {
      return { disposition: 'adopted', owner: cloneOwner(decision.owner) }
    }
    if (decision.kind === 'join') {
      args.onJoin?.(decision.reserved.creation)
      const result = await decision.reserved.promise
      return { disposition: 'adopted', owner: cloneOwner(result.owner as LiveOwner) }
    }

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
        throw args.exitedDuringStart?.() ?? new Error('agent_session_exited_during_start')
      }
      const current = this.live.get(key)
      if (current?.ptyId !== owner.ptyId || current.generation !== owner.generation) {
        throw args.exitedDuringStart?.() ?? new Error('agent_session_exited_during_start')
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
    assertClaimedAgentPtyOwnerCapacity(this.state)
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

  /**
   * What `ensure` would do for this claim now, decided the same way with nothing reserved,
   * released or spawned: the owner it would adopt or join, or null for a fresh create. A refusal
   * throws as `ensure` would.
   */
  async prepare(
    claim: AgentSessionExecutionClaim,
    isLive?: (owner: LiveAgentSessionOwner) => boolean | Promise<boolean>
  ): Promise<AgentSessionOwnerBinding | null> {
    const requestedClaim = cloneClaim(claim)
    let decision = decideClaimedAgentPtyOwner(this.state, requestedClaim)
    while (decision.kind === 'check') {
      const owner = decision.owner
      const live = !isLive || (await isLive(cloneOwner(owner)))
      decision = decideClaimedAgentPtyOwner(
        this.state,
        requestedClaim,
        live ? { proven: owner } : { dead: owner }
      )
    }
    if (decision.kind === 'join') {
      return cloneOwner((await decision.reserved.promise).owner as LiveOwner)
    }
    return decision.kind === 'adopt' ? cloneOwner(decision.owner) : null
  }

  find(claim: AgentSessionExecutionClaim): AgentSessionOwnerBinding | null {
    const owner = this.live.get(agentSessionClaimKey(claim))
    return owner && scopedAgentSessionClaimsEqual(owner.claim, claim) ? cloneOwner(owner) : null
  }

  private rebuildPtyIndex(): void {
    this.keysByPtyId = buildClaimedAgentPtyOwnerIndex(this.live, this.conflicts)
  }
}
