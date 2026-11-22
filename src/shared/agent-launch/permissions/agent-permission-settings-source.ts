import { formatAgentTypeLabel } from '../../agent-status/presentation/agent-type-label'

/** The product whose own settings an Own permission choice follows, named as that product names itself. */
export function agentPermissionSettingsSourceName(agent: string | null | undefined): string {
  return agent === 'claude' ? 'Claude Code' : formatAgentTypeLabel(agent)
}
