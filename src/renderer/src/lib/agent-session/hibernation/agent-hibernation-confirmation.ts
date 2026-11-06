import type { AgentHibernationCandidate } from './agent-hibernation-planner'

export type AgentHibernationConfirmationState = Record<string, string>

export type AgentHibernationPlan = {
  candidates: AgentHibernationCandidate[]
  confirmationState: AgentHibernationConfirmationState
}

export function confirmAgentHibernationCandidates(
  previous: AgentHibernationConfirmationState,
  candidates: AgentHibernationCandidate[]
): AgentHibernationPlan {
  const confirmationState: AgentHibernationConfirmationState = {}
  const confirmed: AgentHibernationCandidate[] = []
  for (const candidate of candidates) {
    confirmationState[candidate.id] = candidate.signature
    if (previous[candidate.id] === candidate.signature) {
      confirmed.push(candidate)
    }
  }
  return { candidates: confirmed, confirmationState }
}
