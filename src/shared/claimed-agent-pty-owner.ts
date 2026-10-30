import {
  dispatchPreparedAgentPtyOwner,
  type PreparedOwnerDispatch,
  type ReservedOwner
} from './claimed-agent-pty-dispatch'
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

export type PreparedAgentPtyOwner = {
  claim: AgentSessionExecutionClaim
  surface: AgentSessionSurfaceBinding
  generation: string
}

type PreparedOwnerResult =
  | { phase: 'live'; owner: LiveAgentSessionOwner }
  | { phase: 'reserved'; owner: PreparedAgentPtyOwner; created: boolean }

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
    const preparation = this.prepare(args)
    const prepared = preparation instanceof Promise ? await preparation : preparation
    if (prepared.phase === 'live') {
      return { disposition: 'adopted', owner: prepared.owner }
    }
    const reserved = this.reserved.get(agentSessionClaimKey(prepared.owner.claim))
    if (!reserved || reserved.generation !== prepared.owner.generation) {
      throw new Error('agent_session_ownership_unknown')
    }
    if (!prepared.created) {
      args.onJoin?.(reserved.creation)
      const result = await reserved.promise
      return { disposition: 'adopted', owner: cloneOwner({ ...result.owner, phase: 'live' }) }
    }
    reserved.creation = args.creation
    return this.dispatchPrepared(prepared.owner, args)
  }

  prepare(args: {
    claim: AgentSessionExecutionClaim
    surface: AgentSessionSurfaceBinding
    isLive?: (owner: LiveAgentSessionOwner) => boolean | Promise<boolean>
    creation?: Promise<PtyCreationDisposition>
  }): PreparedOwnerResult | Promise<PreparedOwnerResult> {
    const requestedClaim = cloneClaim(args.claim)
    const requestedSurface = cloneSurface(args.surface)
    const key = agentSessionClaimKey(requestedClaim)
    if (this.conflicts.has(key)) {
      throw new Error('agent_session_conflict')
    }
    const live = this.live.get(key)
    if (live) {
      if (!scopedAgentSessionClaimsEqual(live.claim, requestedClaim)) {
        throw new Error('agent_session_conflict')
      }
      const reconcile = (isLive: boolean): PreparedOwnerResult | Promise<PreparedOwnerResult> => {
        if (isLive) {
          const current = this.live.get(key)
          if (current?.ptyId === live.ptyId && current.generation === live.generation) {
            return { phase: 'live', owner: cloneOwner(current) }
          }
        } else {
          this.release(live.ptyId, live.generation)
        }
        return this.prepare(args)
      }
      const proof = args.isLive ? args.isLive(cloneOwner(live)) : true
      return proof instanceof Promise ? proof.then(reconcile) : reconcile(proof)
    }
    const existing = this.reserved.get(key)
    if (existing) {
      if (!scopedAgentSessionClaimsEqual(existing.claim, requestedClaim)) {
        throw new Error('agent_session_conflict')
      }
      return { phase: 'reserved', owner: this.copyReservation(existing), created: false }
    }
    for (const owner of [...this.reserved.values(), ...this.live.values()]) {
      if (
        requestedClaim.kind === 'fresh-launch' &&
        owner.surface.worktreeId === requestedSurface.worktreeId &&
        owner.surface.tabId === requestedSurface.tabId &&
        owner.surface.leafId === requestedSurface.leafId
      ) {
        throw new Error('agent_session_conflict')
      }
    }
    this.assertCapacityForNewOwner()
    const completion = Promise.withResolvers<AgentSessionClaimedSpawnResult>()
    void completion.promise.catch(() => {})
    const reservation: ReservedOwner = {
      claim: requestedClaim,
      surface: requestedSurface,
      worktreeScopeDigest: requestedClaim.worktreeScopeDigest,
      generation: randomUUID(),
      phase: 'reserved',
      dispatched: false,
      creation: args.creation,
      ...completion
    }
    this.reserved.set(key, reservation)
    return { phase: 'reserved', owner: this.copyReservation(reservation), created: true }
  }

  cancelPrepared(owner: PreparedAgentPtyOwner): boolean {
    const key = agentSessionClaimKey(owner.claim)
    const reserved = this.reserved.get(key)
    if (!reserved || reserved.generation !== owner.generation || reserved.dispatched) {
      return false
    }
    this.reserved.delete(key)
    reserved.reject(new Error('agent_session_operation_unknown'))
    return true
  }

  private copyReservation(owner: PreparedAgentPtyOwner): PreparedAgentPtyOwner {
    return {
      claim: cloneClaim(owner.claim),
      surface: cloneSurface(owner.surface),
      generation: owner.generation
    }
  }

  dispatchPrepared(
    owner: PreparedAgentPtyOwner,
    args: PreparedOwnerDispatch
  ): Promise<AgentSessionClaimedSpawnResult> {
    return dispatchPreparedAgentPtyOwner(
      {
        reserved: this.reserved,
        live: this.live,
        release: (id, generation) => this.release(id, generation),
        index: (owner) => {
          const keys = this.keysByPtyId.get(owner.ptyId) ?? new Set<string>()
          keys.add(agentSessionClaimKey(owner.claim))
          this.keysByPtyId.set(owner.ptyId, keys)
        }
      },
      owner,
      args
    )
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
