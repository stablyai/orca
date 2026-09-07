import type { AgentMapAgentNode, AgentMapLayout } from './agent-map-layout'
import { shouldAggregateAgentMapWorktree } from './agent-map-layout'

type Direction = { x: number; y: number }

export function agentMapAgents(layout: AgentMapLayout): AgentMapAgentNode[] {
  return layout.projects.flatMap((project) =>
    project.worktrees.flatMap((worktree) => worktree.agents)
  )
}

export function navigableAgentMapAgents(
  layout: AgentMapLayout,
  zoom: number,
  allowAggregation: boolean,
  selectedPaneKey: string | null
): AgentMapAgentNode[] {
  return layout.projects.flatMap((project) =>
    project.worktrees.flatMap((worktree) => {
      const containsSelection = worktree.agents.some(
        (agent) => agent.card.paneKey === selectedPaneKey
      )
      return !containsSelection && shouldAggregateAgentMapWorktree(worktree, zoom, allowAggregation)
        ? []
        : worktree.agents
    })
  )
}

export function nextDirectionalAgent(
  current: AgentMapAgentNode,
  agents: AgentMapAgentNode[],
  direction: Direction
): AgentMapAgentNode | null {
  let best: { agent: AgentMapAgentNode; score: number } | null = null
  for (const candidate of agents) {
    if (candidate.card.paneKey === current.card.paneKey) {
      continue
    }
    const dx = candidate.x - current.x
    const dy = candidate.y - current.y
    const forward = dx * direction.x + dy * direction.y
    if (forward <= 0) {
      continue
    }
    const sideways = Math.abs(dx * direction.y - dy * direction.x)
    const score = forward + sideways * 2
    if (!best || score < best.score) {
      best = { agent: candidate, score }
    }
  }
  return best?.agent ?? null
}
