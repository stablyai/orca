import type { DashboardAgentRow } from '@/components/dashboard/useDashboardData'
import type { CodexSubagentProgressHostAuthority } from './codex-subagent-progress-host-authority'

export type CodexSubagentProgressTarget = {
  sessionId: string
  paneKey: string
  parentPaneKey: string
  terminalTabId: string
  worktreeId: string
  label: string
  model?: string
  hostAuthority: CodexSubagentProgressHostAuthority
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim()
  return trimmed || null
}

export function createCodexSubagentProgressTarget(
  agent: DashboardAgentRow,
  worktreeId: string,
  hostAuthority: CodexSubagentProgressHostAuthority
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
    hostAuthority
  }
}

function parseHostAuthority(value: unknown): CodexSubagentProgressHostAuthority | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  const authority = value as Record<string, unknown>
  switch (authority.kind) {
    case 'local':
    case 'legacy-ssh':
      return { kind: authority.kind }
    case 'runtime': {
      const environmentId = nonEmptyString(authority.environmentId)
      return environmentId ? { kind: 'runtime', environmentId } : null
    }
    case 'unknown':
      return authority.reason === 'unknown-owner' || authority.reason === 'runtime-owner-missing'
        ? { kind: 'unknown', reason: authority.reason }
        : null
    default:
      return null
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
  const hostAuthority = parseHostAuthority(value.hostAuthority)
  if (
    !sessionId ||
    !paneKey ||
    !parentPaneKey ||
    !terminalTabId ||
    !worktreeId ||
    !label ||
    !hostAuthority
  ) {
    return null
  }
  const model = nonEmptyString(value.model)
  return {
    sessionId,
    paneKey,
    parentPaneKey,
    terminalTabId,
    worktreeId,
    label,
    ...(model ? { model } : {}),
    hostAuthority
  }
}
