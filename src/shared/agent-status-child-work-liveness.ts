import type { AgentChildWorkKind, AgentChildWorkState } from './agent-status-child-work'

/** Two-state vocabulary by design: any live agent work reads as `working`; `monitoring`
 *  only when shells and monitors are the sole live work; null when nothing runs. */
export type AgentChildWorkLiveness = 'working' | 'monitoring' | null

export type AgentChildWorkLivenessCandidate = {
  kind: AgentChildWorkKind
  state?: AgentChildWorkState
}

export type AgentChildWorkLivenessEvidence = {
  hasLiveAgentWork: boolean
  hasLiveNonAgentWork: boolean
}

/** Roster membership: is this child a subagent the roster owns? A workflow is not. */
export function isAgentChildWorkKind(kind: AgentChildWorkKind): boolean {
  return kind === 'agent'
}

/** Liveness: may this live child count as mere monitoring? Only shells and monitors, which can loop
 *  forever with no model turn owed; a workflow runs agents, and an unknown kind fails toward working. */
export function isWatchOnlyChildWorkKind(kind: AgentChildWorkKind): boolean {
  return kind === 'command' || kind === 'monitor'
}

/** The settlement rule `resolveAgentChildWorkFreshness` already reads rows by: only an explicit
 *  settled state retires child work. An absent state (an old host's live task), an unknown kind
 *  and a child that lost contact all fail active — and, being not watch-only, read as working — so
 *  nothing untyped or out of touch can silently retire or let the machine sleep.
 *  The escape hatch is the roster's own lifetime, not a state: it is per-session host memory that
 *  dies when the session closes (Claude also clears it on provider `ended`), so a producer that
 *  ever reported a failure IN PLACE rather than settling it would pin `working` until then. */
function isLiveChildWork(child: AgentChildWorkLivenessCandidate): boolean {
  return child.state !== 'done' && child.state !== 'idle'
}

export function agentChildWorkLivenessFromEvidence(
  evidence: AgentChildWorkLivenessEvidence
): AgentChildWorkLiveness {
  if (evidence.hasLiveAgentWork) {
    return 'working'
  }
  return evidence.hasLiveNonAgentWork ? 'monitoring' : null
}

export function agentChildWorkLiveness(
  children: readonly AgentChildWorkLivenessCandidate[] | undefined
): AgentChildWorkLiveness {
  let hasLiveAgentWork = false
  let hasLiveNonAgentWork = false
  for (const child of children ?? []) {
    if (!isLiveChildWork(child)) {
      continue
    }
    hasLiveAgentWork ||= !isWatchOnlyChildWorkKind(child.kind)
    hasLiveNonAgentWork ||= isWatchOnlyChildWorkKind(child.kind)
  }
  return agentChildWorkLivenessFromEvidence({ hasLiveAgentWork, hasLiveNonAgentWork })
}
