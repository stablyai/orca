import { agentStateLabel } from '@/components/AgentStateDot'
import type { DashboardAgentRow as DashboardAgentRowData } from '@/components/dashboard/useDashboardData'
import { formatAgentTypeLabel } from '@/lib/agent-status'
import { getAgentDotState } from './worktree-card-agent-summary'

export const MARKDOWN_IMAGE_PATTERN = /!\[[^\]\n]*\]\([^)]+\)/

function formatShortTimeAgo(ts: number, now: number): string {
  const delta = now - ts
  if (delta < 60_000) {
    return 'now'
  }
  const minutes = Math.floor(delta / 60_000)
  if (minutes < 60) {
    return `${minutes}m`
  }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    return `${hours}h`
  }
  return `${Math.floor(hours / 24)}d`
}

function lastEnteredDoneAt(agent: DashboardAgentRowData): number | null {
  const entry = agent.entry
  if (entry.state === 'done') {
    return entry.stateStartedAt
  }
  for (let i = (entry.stateHistory?.length ?? 0) - 1; i >= 0; i--) {
    if (entry.stateHistory[i].state === 'done') {
      return entry.stateHistory[i].startedAt
    }
  }
  return null
}

export function getCompactAgentPrimary(agent: DashboardAgentRowData): string {
  const prompt = agent.entry.prompt?.trim() ?? ''
  return prompt || agentStateLabel(getAgentDotState(agent))
}

export function getCompactAgentSecondary(agent: DashboardAgentRowData): string {
  if (agent.entry.interrupted === true) {
    return 'Interrupted by user'
  }
  if (agent.state === 'working') {
    const toolName = agent.entry.toolName?.trim() ?? ''
    const toolInput = agent.entry.toolInput?.trim() ?? ''
    if (toolName && toolInput) {
      return `${toolName}: ${toolInput}`
    }
    if (toolName) {
      return toolName
    }
  }
  return agent.entry.lastAssistantMessage?.trim() || formatAgentTypeLabel(agent.agentType)
}

export function getCompactAgentTime(agent: DashboardAgentRowData, now: number): string | null {
  const doneAt = lastEnteredDoneAt(agent)
  if (doneAt !== null) {
    return formatShortTimeAgo(doneAt, now)
  }
  const startedAt = agent.startedAt > 0 ? agent.startedAt : agent.entry.stateStartedAt
  return startedAt > 0 ? formatShortTimeAgo(startedAt, now) : null
}
