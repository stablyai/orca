import { ORCA_ORCHESTRATION_WAIT_COMMAND } from './orca-cli-invocations'
import type {
  AgentChildWorkKind,
  AgentChildWorkMembership,
  AgentChildWorkState
} from './agent-status-child-work'

/** Rank live work as waiting-for-human, then agent working, then shells/monitors-only monitoring; null means nothing runs. */
export type AgentChildWorkLiveness = 'waiting' | 'working' | 'monitoring' | null

export type AgentChildWorkLivenessCandidate = {
  kind: AgentChildWorkKind
  state?: AgentChildWorkState
  /** What the child runs; a producer marks a worker wait with the canonical wait command, which is agent work. */
  operation?: { input?: string } | null
}

export type AgentChildWorkLivenessEvidence = {
  /** A live child of any kind is waiting on a human before it can go on. */
  hasWaitingChildWork: boolean
  hasLiveAgentWork: boolean
  hasLiveNonAgentWork: boolean
}

/** Classify each new kind here. Workflows are not agent work: their agents announce upstream, leaving shell/workflow rows. */
export function isAgentChildWorkKind(kind: AgentChildWorkKind): boolean {
  return kind === 'agent'
}

function isAgentChildWork(child: AgentChildWorkLivenessCandidate): boolean {
  return (
    isAgentChildWorkKind(child.kind) || child.operation?.input === ORCA_ORCHESTRATION_WAIT_COMMAND
  )
}

/** Only explicit settlement retires work: missing states, unknown kinds and lost contact stay active. Roster lifetime bounds this fail-active policy (session close; Claude provider ended); in-place blocked failures would remain working until then. */
export function isLiveChildWork(child: AgentChildWorkLivenessCandidate): boolean {
  return child.state !== 'done' && child.state !== 'idle'
}

/** Only waiting requests a human; child blocked means failure, and unverifiable contact loss asks for no one. */
function isWaitingChildWork(child: AgentChildWorkLivenessCandidate): boolean {
  return child.state === 'waiting'
}

export function agentChildWorkLivenessFromEvidence(
  evidence: AgentChildWorkLivenessEvidence
): AgentChildWorkLiveness {
  if (evidence.hasWaitingChildWork) {
    return 'waiting'
  }
  if (evidence.hasLiveAgentWork) {
    return 'working'
  }
  return evidence.hasLiveNonAgentWork ? 'monitoring' : null
}

export function agentChildWorkLiveness(
  children: readonly AgentChildWorkLivenessCandidate[] | undefined
): AgentChildWorkLiveness {
  let hasWaitingChildWork = false
  let hasLiveAgentWork = false
  let hasLiveNonAgentWork = false
  for (const child of children ?? []) {
    if (!isLiveChildWork(child)) {
      continue
    }
    hasWaitingChildWork ||= isWaitingChildWork(child)
    const agentWork = isAgentChildWork(child)
    hasLiveAgentWork ||= agentWork
    hasLiveNonAgentWork ||= !agentWork
  }
  return agentChildWorkLivenessFromEvidence({
    hasWaitingChildWork,
    hasLiveAgentWork,
    hasLiveNonAgentWork
  })
}

/** One child in the ownership tree: its id, the id of the child that owns it, its membership. */
export type AgentChildWorkOwnershipNode = {
  id: string
  ownerId?: string
  membership: AgentChildWorkMembership
}

/** Keep settled ancestors of live descendants at every depth, monitoring through the next turn so work retains its owner chain. */
export function settledOwnersOfLiveWork(
  children: readonly AgentChildWorkOwnershipNode[]
): Set<string> {
  const byId = new Map(children.map((child) => [child.id, child]))
  const owners = new Set<string>()
  for (const child of children) {
    if (child.membership !== 'live') {
      continue
    }
    const seen = new Set([child.id])
    let owner = child.ownerId ? byId.get(child.ownerId) : undefined
    while (owner && !seen.has(owner.id)) {
      seen.add(owner.id)
      if (owner.membership === 'settled') {
        owners.add(owner.id)
      }
      owner = owner.ownerId ? byId.get(owner.ownerId) : undefined
    }
  }
  return owners
}
