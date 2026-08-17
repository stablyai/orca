import type { DashboardAgentRow as DashboardAgentRowData } from '@/components/dashboard/useDashboardData'
import { formatAgentTypeLabel } from '@/lib/agent-status'

/**
 * Compact agent-row secondary line. Surfaces live worktree mismatch first so a
 * row still filed under its spawn worktree is not silently wrong (#10572).
 */
export function getCompactAgentSecondary(agent: DashboardAgentRowData): string {
  const mismatch = agent.liveWorktreeMismatchLabel?.trim() ?? ''
  const detail = getCompactAgentSecondaryDetail(agent)
  if (mismatch && detail) {
    return `${mismatch} · ${detail}`
  }
  if (mismatch) {
    return mismatch
  }
  if (detail) {
    return detail
  }
  // Why: child rows without descriptions use their role as primary text; repeating its formatted label adds no information.
  if (agent.rowSource === 'subagent' && agent.entry.prompt?.trim() === agent.agentType.trim()) {
    return ''
  }
  return formatAgentTypeLabel(agent.agentType)
}

function getCompactAgentSecondaryDetail(agent: DashboardAgentRowData): string {
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
  const lastAssistantMessage = agent.entry.lastAssistantMessage?.trim()
  if (lastAssistantMessage) {
    return lastAssistantMessage
  }
  return ''
}
