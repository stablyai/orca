import type { PtyCreationDisposition } from './pty-creation-disposition'
import type {
  AgentSessionClaimedSpawnResult,
  AgentSessionExecutionClaim,
  AgentSessionOwnerBinding
} from './agent-session/agent-session-host-authority'
import type { PreparedAgentPtyOwner } from './claimed-agent-pty-owner'
import {
  agentSessionClaimKey,
  agentSessionSurfacesEqual,
  cloneAgentSessionClaim as cloneClaim,
  cloneAgentSessionSurface as cloneSurface,
  cloneAgentSessionOwner as cloneOwner,
  scopedAgentSessionClaimsEqual,
  type LiveAgentSessionOwner
} from './claimed-agent-pty-owner-snapshot'
type LiveOwner = LiveAgentSessionOwner

export type ReservedOwner = PreparedAgentPtyOwner & {
  claim: AgentSessionExecutionClaim
  worktreeScopeDigest: string
  generation: string
  phase: 'reserved'
  dispatched: boolean
  resolve: (result: AgentSessionClaimedSpawnResult) => void
  reject: (error: unknown) => void
  promise: Promise<AgentSessionClaimedSpawnResult>
  creation?: Promise<PtyCreationDisposition>
}

export type PreparedOwnerDispatch = {
  spawn: (reservation: { generation: string }) => Promise<{
    ptyId: string
    owner?: AgentSessionOwnerBinding
    disposition?: AgentSessionClaimedSpawnResult['disposition']
  }>
  isLive?: (owner: LiveAgentSessionOwner) => boolean | Promise<boolean>
  creation?: Promise<PtyCreationDisposition>
  exitedDuringStart?: () => Error
}

type PreparedOwnerRegistry = {
  reserved: Map<string, ReservedOwner>
  live: Map<string, LiveAgentSessionOwner>
  release: (ptyId: string, generation: string) => void
  index: (owner: LiveAgentSessionOwner) => void
}

type PreparedDispatchOutcome =
  | { kind: 'joined'; promise: Promise<AgentSessionClaimedSpawnResult> }
  | { kind: 'spawned'; reserved: ReservedOwner; result: AgentSessionClaimedSpawnResult }
  | { kind: 'failed'; reserved: ReservedOwner; error: unknown }

/**
 * Runs the one physical spawn of an exact reservation without settling it. The caller settles in
 * its own frame, so the creator's caller always hears the outcome before any joiner.
 */
export async function runPreparedAgentPtyDispatch(
  registry: PreparedOwnerRegistry,
  owner: PreparedAgentPtyOwner,
  args: PreparedOwnerDispatch
): Promise<PreparedDispatchOutcome> {
  const requestedClaim = cloneClaim(owner.claim)
  const requestedSurface = cloneSurface(owner.surface)
  const key = agentSessionClaimKey(requestedClaim)
  const reserved = registry.reserved.get(key)
  const generation = owner.generation
  if (
    !reserved ||
    reserved.generation !== generation ||
    !agentSessionSurfacesEqual(reserved.surface, requestedSurface)
  ) {
    throw new Error('agent_session_ownership_unknown')
  }
  if (reserved.dispatched) {
    return { kind: 'joined', promise: reserved.promise }
  }
  try {
    reserved.dispatched = true
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
    const reservation = registry.reserved.get(key)
    if (reservation?.generation !== generation) {
      throw new Error('agent_session_ownership_unknown')
    }
    registry.live.set(key, owner)
    registry.index(owner)
    // Index before awaited proof so an exit beating spawn completion can remove the matching generation.
    if (args.isLive && !(await args.isLive(cloneOwner(owner)))) {
      registry.release(owner.ptyId, owner.generation)
      throw args.exitedDuringStart?.() ?? new Error('agent_session_exited_during_start')
    }
    const current = registry.live.get(key)
    if (current?.ptyId !== owner.ptyId || current.generation !== owner.generation) {
      throw args.exitedDuringStart?.() ?? new Error('agent_session_exited_during_start')
    }
    return {
      kind: 'spawned',
      reserved,
      result: { disposition: spawned.disposition ?? 'created', owner: cloneOwner(owner) }
    }
  } catch (error) {
    return { kind: 'failed', reserved, error }
  }
}

/** Shares the creator's outcome with joiners, then returns it to the creator in the same frame. */
export function settlePreparedAgentPtyDispatch(
  registry: PreparedOwnerRegistry,
  owner: PreparedAgentPtyOwner,
  outcome: PreparedDispatchOutcome,
  creation: Promise<PtyCreationDisposition> | undefined
): AgentSessionClaimedSpawnResult | Promise<AgentSessionClaimedSpawnResult> {
  if (outcome.kind === 'joined') {
    return outcome.promise
  }
  const key = agentSessionClaimKey(owner.claim)
  const finish = () => {
    if (registry.reserved.get(key)?.generation === owner.generation) {
      registry.reserved.delete(key)
    }
  }
  if (outcome.kind === 'spawned') {
    outcome.reserved.resolve(outcome.result)
    finish()
    return outcome.result
  }
  outcome.reserved.reject(outcome.error)
  if (!creation) {
    finish()
  } else {
    void creation.then(async (disposition) => {
      if (disposition.kind === 'unknown') {
        return
      }
      if (disposition.kind === 'physical' || disposition.kind === 'failed') {
        await disposition.completion
      }
      finish()
    })
  }
  throw outcome.error
}
