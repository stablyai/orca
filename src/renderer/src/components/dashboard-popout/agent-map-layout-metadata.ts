import type { DashboardCard } from '../../../../shared/dashboard-snapshot'
import type { AgentMapLayout, AgentMapStatusCounts } from './agent-map-layout'
import { agentMapDurationMinutes, agentMapNodeStatus } from './agent-map-node-metadata'

function emptyStatusCounts(): AgentMapStatusCounts {
  return { working: 0, blocked: 0, waiting: 0, done: 0, idle: 0 }
}

export function refreshAgentMapMetadata(
  geometry: AgentMapLayout,
  cards: DashboardCard[],
  now: number
): AgentMapLayout {
  const cardsByPaneKey = new Map(cards.map((card) => [card.paneKey, card]))
  const projects = geometry.projects.map((project) => {
    let projectName = project.name
    let agentCount = 0
    const worktrees = project.worktrees.map((worktree) => {
      let worktreeName = worktree.name
      let workspaceKind = worktree.workspaceKind
      const statusCounts = emptyStatusCounts()
      const agents = worktree.agents.flatMap((agent) => {
        const card = cardsByPaneKey.get(agent.card.paneKey)
        if (!card) {
          return []
        }
        projectName = card.repoName
        worktreeName = card.worktreeName
        workspaceKind = card.workspaceKind ?? 'worktree'
        agentCount += 1
        statusCounts[agentMapNodeStatus(card)] += 1
        return [
          {
            ...agent,
            card,
            durationMinutes: agentMapDurationMinutes(card, now),
            status: agentMapNodeStatus(card)
          }
        ]
      })
      return {
        ...worktree,
        name: worktreeName,
        workspaceKind,
        agents,
        statusCounts,
        quiet: statusCounts.idle === agents.length
      }
    })
    return { ...project, name: projectName, worktrees, agentCount }
  })
  return { ...geometry, projects }
}
