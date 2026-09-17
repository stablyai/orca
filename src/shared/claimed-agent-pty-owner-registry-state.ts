import type {
  AgentSessionClaimedSpawnResult,
  AgentSessionExecutionClaim,
  AgentSessionOwnerBinding,
  AgentSessionSurfaceBinding
} from './agent-session-host-authority'
import type { AgentStatusExecutionBinding } from './agent-status-run'
import {
  agentSessionClaimKey,
  buildClaimedAgentPtyOwnerIndex,
  cloneAgentSessionOwner,
  cloneAgentStatusExecutionBinding,
  countClaimedAgentPtyOwners,
  prepareRegisteredAgentSessionOwner,
  reconcileClaimedAgentPtyOwnerSnapshot,
  scopedAgentSessionClaimsEqual,
  type LiveAgentSessionOwner
} from './claimed-agent-pty-owner-snapshot'
import {
  assertClaimedAgentPtyOwnerCapacity,
  MAX_CLAIMED_AGENT_PTY_OWNER_ENTRIES
} from './claimed-agent-pty-owner-capacity'
import { findClaimedAgentStatusBinding } from './claimed-agent-pty-owner-status-binding'

export type ReservedAgentPtyOwner = {
  claim: AgentSessionExecutionClaim
  worktreeScopeDigest: string
  generation: string
  phase: 'reserved'
  surface: AgentSessionSurfaceBinding
  statusBinding: AgentStatusExecutionBinding
  promise: Promise<AgentSessionClaimedSpawnResult>
}

export abstract class ClaimedAgentPtyOwnerRegistryState {
  protected readonly reserved = new Map<string, ReservedAgentPtyOwner>()
  protected readonly live = new Map<string, LiveAgentSessionOwner>()
  protected readonly conflicts = new Map<string, LiveAgentSessionOwner[]>()
  protected keysByPtyId = new Map<string, Set<string>>()

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
    assertClaimedAgentPtyOwnerCapacity(this.live, this.conflicts, this.reserved.size)
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

    // Why: recovery decisions must observe one complete provider snapshot.
    this.live.clear()
    this.conflicts.clear()
    for (const [key, owner] of next.live) {
      this.live.set(key, owner)
    }
    for (const [key, conflict] of next.conflicts) {
      this.conflicts.set(key, conflict)
    }
    this.keysByPtyId = buildClaimedAgentPtyOwnerIndex(this.live, this.conflicts)
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
    this.keysByPtyId = buildClaimedAgentPtyOwnerIndex(this.live, this.conflicts)
  }

  list(): AgentSessionOwnerBinding[] {
    return [...this.live.values()].map(cloneAgentSessionOwner)
  }

  listForPty(ptyId: string): AgentSessionOwnerBinding[] {
    const keys = this.keysByPtyId.get(ptyId)
    if (!keys) {
      return []
    }
    return [...keys]
      .map((key) => this.live.get(key))
      .filter((owner): owner is LiveAgentSessionOwner => owner !== undefined)
      .map(cloneAgentSessionOwner)
  }

  find(claim: AgentSessionExecutionClaim): AgentSessionOwnerBinding | null {
    const owner = this.live.get(agentSessionClaimKey(claim))
    return owner && scopedAgentSessionClaimsEqual(owner.claim, claim)
      ? cloneAgentSessionOwner(owner)
      : null
  }

  findStatusBinding(args: {
    paneKey: string
    worktreeId?: string
    agent?: string
    runId: string
    executionId: string
  }): AgentStatusExecutionBinding | null {
    const binding = findClaimedAgentStatusBinding({
      live: this.live.values(),
      reserved: this.reserved.values(),
      ...args
    })
    return binding ? cloneAgentStatusExecutionBinding(binding) : null
  }
}
