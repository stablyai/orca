import type { AgentStatusState, AgentType } from './agent-status-types'

export type SyntheticAgentTitleProfile = {
  workingLabel: string
  permissionLabel: string
  idleLabel: string
}

export const SYNTHETIC_AGENT_TITLE_PROFILES: Record<string, SyntheticAgentTitleProfile> = {
  cursor: {
    workingLabel: 'Cursor Agent',
    permissionLabel: 'Cursor - action required',
    idleLabel: 'Cursor ready'
  },
  opencode: {
    workingLabel: 'OpenCode',
    permissionLabel: 'OpenCode - action required',
    idleLabel: 'OpenCode ready'
  },
  droid: {
    workingLabel: 'Droid',
    permissionLabel: 'Droid - action required',
    idleLabel: 'Droid ready'
  },
  hermes: {
    workingLabel: 'Hermes',
    permissionLabel: 'Hermes - action required',
    idleLabel: 'Hermes ready'
  }
}

export function getSyntheticAgentTitleProfile(
  agentType: AgentType | null | undefined
): SyntheticAgentTitleProfile | null {
  if (!agentType) {
    return null
  }
  return SYNTHETIC_AGENT_TITLE_PROFILES[agentType] ?? null
}

export function getSyntheticAgentTerminalTitle(
  agentType: AgentType | null | undefined,
  state: AgentStatusState
): string | null {
  const profile = getSyntheticAgentTitleProfile(agentType)
  if (!profile || state === 'working') {
    return null
  }
  return state === 'blocked' || state === 'waiting' ? profile.permissionLabel : profile.idleLabel
}
