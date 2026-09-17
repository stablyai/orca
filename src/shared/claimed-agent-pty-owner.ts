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
  cloneAgentSessionClaim,
  cloneAgentSessionOwner,
  cloneAgentSessionOwnerBinding,
  cloneAgentSessionSurface,
  cloneAgentStatusExecutionBinding,
  parseSpawnedAgentSessionOwner,
  scopedAgentSessionClaimsEqual,
  type LiveAgentSessionOwner
} from './claimed-agent-pty-owner-snapshot'
import type { AgentStatusExecutionBinding } from './agent-status-run'
import { assertClaimedAgentPtyOwnerCapacity } from './claimed-agent-pty-owner-capacity'
import {
  canReplaceDiscoveredProcess,
  isSameDiscoveredProcess
} from './claimed-agent-pty-owner-discovery'
import {
  ClaimedAgentPtyOwnerRegistryState,
  type ReservedAgentPtyOwner
} from './claimed-agent-pty-owner-registry-state'

export { agentSessionOwnerBindingsEqual } from './claimed-agent-pty-owner-snapshot'
export { MAX_CLAIMED_AGENT_PTY_OWNER_ENTRIES } from './claimed-agent-pty-owner-capacity'
export { canRetireDiscoveredProcessFromObservation } from './claimed-agent-pty-owner-discovery'

type LiveOwner = LiveAgentSessionOwner

export class ClaimedAgentPtyOwnerRegistry extends ClaimedAgentPtyOwnerRegistryState {
  async ensure(args: {
    claim: AgentSessionExecutionClaim
    surface: AgentSessionSurfaceBinding
    discoveryProcess?: AgentSessionOwnerBinding['discoveryProcess']
    /** Replace only earlier discovery-owned processes on this exact PTY. */
    replaceDiscoveredPtyId?: string
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
    const requestedClaim = cloneAgentSessionClaim(args.claim)
    const requestedSurface = cloneAgentSessionSurface(args.surface)
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
      if (!args.isLive || (await args.isLive(cloneAgentSessionOwner(live)))) {
        const current = this.live.get(key)
        if (current?.ptyId === live.ptyId && current.generation === live.generation) {
          return { disposition: 'adopted', owner: cloneAgentSessionOwner(current) }
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
      if (result.owner.phase !== 'live') {
        throw new Error('agent_session_ownership_unknown')
      }
      return { disposition: 'adopted', owner: cloneAgentSessionOwnerBinding(result.owner) }
    }

    if (args.discoveryProcess && args.replaceDiscoveredPtyId) {
      const discoveryProcess = args.discoveryProcess
      const prior = this.listForPty(args.replaceDiscoveredPtyId).filter(
        (owner) =>
          owner.discoveryProcess !== undefined &&
          !isSameDiscoveredProcess(owner.discoveryProcess, discoveryProcess)
      )
      if (
        prior.some(
          (owner) =>
            owner.discoveryProcess &&
            !canReplaceDiscoveredProcess(owner.discoveryProcess, discoveryProcess)
        )
      ) {
        throw new Error('agent_session_observation_stale')
      }
      if (prior.length === 1) {
        continuityOf = prior[0]?.statusBinding.runId
      }
    }

    assertClaimedAgentPtyOwnerCapacity(this.live, this.conflicts, this.reserved.size)
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
    const reservation: ReservedAgentPtyOwner = {
      claim: requestedClaim,
      worktreeScopeDigest: requestedClaim.worktreeScopeDigest,
      generation,
      phase: 'reserved',
      surface: requestedSurface,
      statusBinding,
      promise
    }
    this.reserved.set(key, reservation)

    let promotedOwner: LiveOwner | null = null
    try {
      const spawned = await args.spawn({ generation, statusBinding })
      if (args.discoveryProcess && args.replaceDiscoveredPtyId) {
        const discoveryProcess = args.discoveryProcess
        const currentPtyOwners = this.listForPty(args.replaceDiscoveredPtyId)
        if (currentPtyOwners.some((owner) => owner.discoveryProcess === undefined)) {
          throw new Error('managed_owner_present')
        }
        const replaced = currentPtyOwners.filter(
          (owner) =>
            owner.discoveryProcess !== undefined &&
            !isSameDiscoveredProcess(owner.discoveryProcess, discoveryProcess)
        )
        if (
          replaced.some(
            (owner) =>
              owner.discoveryProcess &&
              !canReplaceDiscoveredProcess(owner.discoveryProcess, discoveryProcess)
          )
        ) {
          throw new Error('agent_session_observation_stale')
        }
        if (replaced.length === 1) {
          statusBinding.continuityOf = replaced[0]?.statusBinding.runId
        }
        for (const owner of replaced) {
          this.release(owner.ptyId, owner.generation)
        }
      }
      const canonicalOwner = parseSpawnedAgentSessionOwner(spawned.owner)
      const owner: LiveOwner = canonicalOwner
        ? {
            claim: cloneAgentSessionClaim(canonicalOwner.claim),
            generation: canonicalOwner.generation,
            phase: 'live',
            ptyId: canonicalOwner.ptyId,
            surface: cloneAgentSessionSurface(canonicalOwner.surface),
            statusBinding: cloneAgentStatusExecutionBinding(canonicalOwner.statusBinding),
            ...(canonicalOwner.discoveryProcess
              ? {
                  discoveryProcess: {
                    ...canonicalOwner.discoveryProcess,
                    ...(canonicalOwner.discoveryProcess.providerObservation
                      ? {
                          providerObservation: {
                            ...canonicalOwner.discoveryProcess.providerObservation,
                            process: {
                              ...canonicalOwner.discoveryProcess.providerObservation.process
                            }
                          }
                        }
                      : {})
                  }
                }
              : {})
          }
        : {
            claim: requestedClaim,
            generation,
            phase: 'live',
            ptyId: spawned.ptyId,
            surface: requestedSurface,
            statusBinding,
            ...(args.discoveryProcess
              ? {
                  discoveryProcess: {
                    ...args.discoveryProcess,
                    ...(args.discoveryProcess.providerObservation
                      ? {
                          providerObservation: {
                            ...args.discoveryProcess.providerObservation,
                            process: { ...args.discoveryProcess.providerObservation.process }
                          }
                        }
                      : {})
                  }
                }
              : {})
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
      if (args.isLive && !(await args.isLive(cloneAgentSessionOwner(owner)))) {
        throw new Error('agent_session_exited_during_start')
      }
      const current = this.live.get(key)
      if (current?.ptyId !== owner.ptyId || current.generation !== owner.generation) {
        throw new Error('agent_session_exited_during_start')
      }
      const result: AgentSessionClaimedSpawnResult = {
        disposition: spawned.disposition ?? 'created',
        owner: cloneAgentSessionOwner(owner)
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
}
