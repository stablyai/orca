import { randomUUID } from 'node:crypto'
import type {
  AgentSessionExecutionClaim,
  AgentSessionRpcOwnerBinding
} from './agent-session-host-authority'
import {
  agentSessionClaimKey,
  cloneAgentSessionClaim,
  scopedAgentSessionClaimsEqual
} from './claimed-agent-pty-owner-snapshot'

type ReservedRpcOwner = AgentSessionRpcOwnerBinding & { phase: 'reserved' }
type LiveRpcOwner = AgentSessionRpcOwnerBinding & { phase: 'live' }

export type ClaimedAgentRpcOwnerResult<T> = {
  owner: LiveRpcOwner
  value: T
}

export class ClaimedAgentRpcSpawnError extends Error {
  constructor(readonly spawnCause: unknown) {
    super(spawnCause instanceof Error ? spawnCause.message : String(spawnCause))
    this.name = 'ClaimedAgentRpcSpawnError'
  }
}

function cloneRpcOwner<T extends AgentSessionRpcOwnerBinding>(owner: T): T {
  return {
    claim: cloneAgentSessionClaim(owner.claim),
    generation: owner.generation,
    phase: owner.phase,
    ownerKind: 'omp-rpc'
  } as T
}

export class ClaimedAgentRpcOwnerState {
  private readonly reserved = new Map<string, ReservedRpcOwner>()
  private readonly live = new Map<string, LiveRpcOwner>()

  get size(): number {
    return this.reserved.size + this.live.size
  }

  hasClaimKey(key: string): boolean {
    return this.reserved.has(key) || this.live.has(key)
  }

  async ensure<T>(args: {
    claim: AgentSessionExecutionClaim
    spawn: (reservation: { generation: string }) => T | Promise<T>
    hasPtyClaim: (key: string) => boolean
    assertCapacity: () => void
  }): Promise<ClaimedAgentRpcOwnerResult<T>> {
    const requestedClaim = cloneAgentSessionClaim(args.claim)
    const key = agentSessionClaimKey(requestedClaim)
    if (args.hasPtyClaim(key) || this.hasClaimKey(key)) {
      throw new Error('agent_session_conflict')
    }

    args.assertCapacity()
    const generation = randomUUID()
    const reservation: ReservedRpcOwner = {
      claim: requestedClaim,
      generation,
      phase: 'reserved',
      ownerKind: 'omp-rpc'
    }
    this.reserved.set(key, reservation)
    try {
      let value: T
      try {
        value = await args.spawn({ generation })
      } catch (error) {
        throw new ClaimedAgentRpcSpawnError(error)
      }
      const current = this.reserved.get(key)
      if (
        current?.generation !== generation ||
        !scopedAgentSessionClaimsEqual(current.claim, requestedClaim)
      ) {
        throw new Error('agent_session_ownership_unknown')
      }
      const owner: LiveRpcOwner = { ...reservation, phase: 'live' }
      this.reserved.delete(key)
      this.live.set(key, owner)
      return { owner: cloneRpcOwner(owner), value }
    } catch (error) {
      if (this.reserved.get(key)?.generation === generation) {
        this.reserved.delete(key)
      }
      throw error
    }
  }

  readonly release = (owner: AgentSessionRpcOwnerBinding): boolean => {
    const key = agentSessionClaimKey(owner.claim)
    const current = this.live.get(key)
    if (
      !current ||
      current.generation !== owner.generation ||
      !scopedAgentSessionClaimsEqual(current.claim, owner.claim)
    ) {
      return false
    }
    this.live.delete(key)
    return true
  }

  readonly find = (claim: AgentSessionExecutionClaim): AgentSessionRpcOwnerBinding | null => {
    const owner = this.live.get(agentSessionClaimKey(claim))
    return owner && scopedAgentSessionClaimsEqual(owner.claim, claim) ? cloneRpcOwner(owner) : null
  }
}
