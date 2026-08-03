import type { DashboardAgentRow } from '@/components/dashboard/useDashboardData'
import type { AgentStatusState } from '../../../../shared/agent-status-types'

export type CodexSubagentProgressTarget = {
  sessionId: string
  paneKey: string
  parentPaneKey: string
  terminalTabId: string
  worktreeId: string
  label: string
  model?: string
  state: AgentStatusState | 'idle'
  connectionId?: string | null
}

const TARGET_STATES = new Set<AgentStatusState | 'idle'>([
  'working',
  'blocked',
  'waiting',
  'done',
  'idle'
])

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim()
  return trimmed || null
}

export function createCodexSubagentProgressTarget(
  agent: DashboardAgentRow,
  worktreeId: string
): CodexSubagentProgressTarget | null {
  const session = agent.subagentSession
  if (agent.rowSource !== 'subagent' || session?.provider !== 'codex') {
    return null
  }
  const label =
    agent.entry.orchestration?.displayName?.trim() ||
    agent.entry.prompt.trim() ||
    agent.agentType.trim() ||
    'Codex subagent'
  const model = agent.entry.model?.trim() || undefined
  return {
    sessionId: session.id,
    paneKey: agent.paneKey,
    parentPaneKey: session.parentPaneKey,
    terminalTabId: agent.tab.id,
    worktreeId,
    label,
    ...(model ? { model } : {}),
    state: agent.state,
    connectionId: agent.entry.connectionId
  }
}

export function parseCodexSubagentProgressTarget(
  value: Record<string, unknown>
): CodexSubagentProgressTarget | null {
  const sessionId = nonEmptyString(value.sessionId)
  const paneKey = nonEmptyString(value.paneKey)
  const parentPaneKey = nonEmptyString(value.parentPaneKey)
  const terminalTabId = nonEmptyString(value.terminalTabId)
  const worktreeId = nonEmptyString(value.worktreeId)
  const label = nonEmptyString(value.label)
  const state = value.state
  if (
    !sessionId ||
    !paneKey ||
    !parentPaneKey ||
    !terminalTabId ||
    !worktreeId ||
    !label ||
    typeof state !== 'string' ||
    !TARGET_STATES.has(state as AgentStatusState | 'idle')
  ) {
    return null
  }
  const model = nonEmptyString(value.model)
  const connectionId = value.connectionId
  if (connectionId !== undefined && connectionId !== null && typeof connectionId !== 'string') {
    return null
  }
  return {
    sessionId,
    paneKey,
    parentPaneKey,
    terminalTabId,
    worktreeId,
    label,
    ...(model ? { model } : {}),
    state: state as AgentStatusState | 'idle',
    ...(connectionId === undefined ? {} : { connectionId })
  }
}
