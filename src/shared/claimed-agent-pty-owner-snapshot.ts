import type {
  AgentSessionExecutionClaim,
  AgentSessionOwnerBinding,
  AgentSessionSurfaceBinding
} from './agent-session-host-authority'

export type LiveAgentSessionOwner = AgentSessionOwnerBinding & { phase: 'live' }

export function agentSessionClaimKey(claim: AgentSessionExecutionClaim): string {
  return `${claim.digestVersion}:${claim.keyId}:${claim.agent}:${claim.identityDigest}`
}

export function agentSessionClaimsEqual(
  left: AgentSessionExecutionClaim,
  right: AgentSessionExecutionClaim
): boolean {
  return (
    left.digestVersion === right.digestVersion &&
    left.keyId === right.keyId &&
    left.identityDigest === right.identityDigest &&
    left.agent === right.agent
  )
}

export function scopedAgentSessionClaimsEqual(
  left: AgentSessionExecutionClaim,
  right: AgentSessionExecutionClaim
): boolean {
  return (
    agentSessionClaimsEqual(left, right) && left.worktreeScopeDigest === right.worktreeScopeDigest
  )
}

export function agentSessionSurfacesEqual(
  left: AgentSessionSurfaceBinding,
  right: AgentSessionSurfaceBinding
): boolean {
  return (
    left.worktreeId === right.worktreeId &&
    left.tabId === right.tabId &&
    left.leafId === right.leafId &&
    left.terminalHandle === right.terminalHandle
  )
}

export function agentSessionOwnerBindingsEqual(
  left: AgentSessionOwnerBinding,
  right: AgentSessionOwnerBinding
): boolean {
  return (
    left.phase === 'live' &&
    right.phase === 'live' &&
    left.generation === right.generation &&
    left.ptyId === right.ptyId &&
    scopedAgentSessionClaimsEqual(left.claim, right.claim) &&
    agentSessionSurfacesEqual(left.surface, right.surface)
  )
}

export function cloneAgentSessionOwner(owner: LiveAgentSessionOwner): LiveAgentSessionOwner {
  return {
    ...owner,
    claim: { ...owner.claim },
    surface: { ...owner.surface }
  }
}

export function prepareRegisteredAgentSessionOwner(args: {
  owner: AgentSessionOwnerBinding
  existing?: LiveAgentSessionOwner
  reserved: boolean
  conflicted: boolean
}): LiveAgentSessionOwner | null {
  if (args.owner.phase !== 'live') {
    throw new Error('agent_session_ownership_unknown')
  }
  if (args.reserved || args.conflicted) {
    throw new Error('agent_session_conflict')
  }
  if (args.existing) {
    if (
      args.existing.generation !== args.owner.generation ||
      args.existing.ptyId !== args.owner.ptyId
    ) {
      throw new Error('agent_session_conflict')
    }
    if (!agentSessionOwnerBindingsEqual(args.existing, args.owner)) {
      throw new Error('agent_session_ownership_unknown')
    }
    return null
  }
  return cloneAgentSessionOwner({ ...args.owner, phase: 'live' })
}

export function buildClaimedAgentPtyOwnerIndex(
  live: ReadonlyMap<string, LiveAgentSessionOwner>,
  conflicts: ReadonlyMap<string, LiveAgentSessionOwner[]>
): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>()
  const add = (key: string, owner: LiveAgentSessionOwner): void => {
    const keys = result.get(owner.ptyId) ?? new Set<string>()
    keys.add(key)
    result.set(owner.ptyId, keys)
  }
  for (const [key, owner] of live) {
    add(key, owner)
  }
  for (const [key, owners] of conflicts) {
    for (const owner of owners) {
      add(key, owner)
    }
  }
  return result
}

function addUniqueEvidence(
  evidenceByKey: Map<string, LiveAgentSessionOwner[]>,
  owner: AgentSessionOwnerBinding
): void {
  const cloned = cloneAgentSessionOwner({ ...owner, phase: 'live' })
  const key = agentSessionClaimKey(cloned.claim)
  const evidence = evidenceByKey.get(key) ?? []
  const sameGeneration = evidence.find(
    (candidate) => candidate.ptyId === cloned.ptyId && candidate.generation === cloned.generation
  )
  if (sameGeneration && !agentSessionOwnerBindingsEqual(sameGeneration, cloned)) {
    throw new Error('agent_session_ownership_unknown')
  }
  if (!evidence.some((candidate) => agentSessionOwnerBindingsEqual(candidate, cloned))) {
    evidence.push(cloned)
    evidenceByKey.set(key, evidence)
  }
}

export function reconcileClaimedAgentPtyOwnerSnapshot(args: {
  live: ReadonlyMap<string, LiveAgentSessionOwner>
  conflicts: ReadonlyMap<string, LiveAgentSessionOwner[]>
  reservedKeys: ReadonlySet<string>
  incoming: readonly AgentSessionOwnerBinding[]
  isInAuthoritativeScope: (owner: AgentSessionOwnerBinding) => boolean
}): {
  live: Map<string, LiveAgentSessionOwner>
  conflicts: Map<string, LiveAgentSessionOwner[]>
} {
  const incomingByKey = new Map<string, LiveAgentSessionOwner[]>()
  for (const owner of args.incoming) {
    if (owner.phase !== 'live') {
      throw new Error('agent_session_ownership_unknown')
    }
    addUniqueEvidence(incomingByKey, owner)
  }

  const evidenceByKey = new Map<string, LiveAgentSessionOwner[]>()
  const existing = [...args.live.values(), ...args.conflicts.values()].flat()
  for (const owner of existing) {
    if (!args.isInAuthoritativeScope(owner)) {
      addUniqueEvidence(evidenceByKey, owner)
    }
  }
  for (const incoming of incomingByKey.values()) {
    for (const owner of incoming) {
      addUniqueEvidence(evidenceByKey, owner)
    }
  }

  const nextLive = new Map<string, LiveAgentSessionOwner>()
  const nextConflicts = new Map<string, LiveAgentSessionOwner[]>()
  const keys = new Set([...args.live.keys(), ...args.conflicts.keys(), ...evidenceByKey.keys()])
  for (const key of keys) {
    if (args.reservedKeys.has(key)) {
      const current = args.live.get(key)
      if (current) {
        nextLive.set(key, current)
      }
      const conflict = args.conflicts.get(key)
      if (conflict) {
        nextConflicts.set(key, conflict)
      }
      continue
    }
    const evidence = evidenceByKey.get(key) ?? []
    if (evidence.length === 1) {
      nextLive.set(key, evidence[0])
    } else if (evidence.length > 1) {
      nextConflicts.set(key, evidence)
    }
  }
  return { live: nextLive, conflicts: nextConflicts }
}
