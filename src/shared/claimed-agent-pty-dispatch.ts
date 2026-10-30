import type { PtyCreationDisposition } from './pty-creation-disposition'
import type {
  AgentSessionClaimedSpawnResult,
  AgentSessionExecutionClaim,
  AgentSessionOwnerBinding
} from './agent-session-host-authority'
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
}

type PreparedOwnerRegistry = {
  reserved: Map<string, ReservedOwner>
  live: Map<string, LiveAgentSessionOwner>
  release: (ptyId: string, generation: string) => void
  index: (owner: LiveAgentSessionOwner) => void
}

export async function dispatchPreparedAgentPtyOwner(
  registry: PreparedOwnerRegistry,
  owner: PreparedAgentPtyOwner,
  args: PreparedOwnerDispatch
): Promise<AgentSessionClaimedSpawnResult> {
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
    return reserved.promise
  }
  let published = false
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
      throw new Error('agent_session_exited_during_start')
    }
    const current = registry.live.get(key)
    if (current?.ptyId !== owner.ptyId || current.generation !== owner.generation) {
      throw new Error('agent_session_exited_during_start')
    }
    const result: AgentSessionClaimedSpawnResult = {
      disposition: spawned.disposition ?? 'created',
      owner: cloneOwner(owner)
    }
    reserved.resolve(result)
    published = true
    return result
  } catch (error) {
    reserved.reject(error)
    throw error
  } finally {
    const finish = () => {
      if (registry.reserved.get(key)?.generation === generation) {
        registry.reserved.delete(key)
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
