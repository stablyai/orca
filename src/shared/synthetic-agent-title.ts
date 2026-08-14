import type { AgentStatusState, AgentType } from './agent-status-types'

export type SyntheticAgentTitleProfile = {
  workingLabel: string
  permissionLabel: string
  idleLabel: string
  titleIdentityGroup?: string
  /** The group's generic member, whose frames every other member also emits. A specific
   *  sibling identity outranks it so the pane label can't oscillate between the two. */
  titleIdentityFallback?: boolean
  synthesizeTerminalTitle?: boolean
  synthesizeWorkingTitle?: boolean
}

export const SYNTHETIC_AGENT_TITLE_PROFILES: Record<string, SyntheticAgentTitleProfile> = {
  codex: {
    workingLabel: 'Codex',
    permissionLabel: 'Codex - action required',
    idleLabel: 'Codex ready',
    // Why: Codex emits working OSC titles but can miss the final frame.
    // Only synthesize terminal states so native spinner behavior stays intact.
    synthesizeWorkingTitle: false
  },
  cursor: {
    workingLabel: 'Cursor Agent',
    permissionLabel: 'Cursor - action required',
    idleLabel: 'Cursor ready'
  },
  opencode: {
    workingLabel: 'OpenCode',
    permissionLabel: 'OpenCode - action required',
    idleLabel: 'OpenCode ready',
    // Why: OpenCode owns semantic OSC session titles; hook status must not replace them.
    synthesizeTerminalTitle: false
  },
  pi: {
    workingLabel: 'Pi',
    permissionLabel: 'Pi - action required',
    idleLabel: 'Pi ready',
    titleIdentityGroup: 'pi-compatible',
    titleIdentityFallback: true
  },
  omp: {
    workingLabel: 'OMP',
    permissionLabel: 'OMP - action required',
    idleLabel: 'OMP ready',
    titleIdentityGroup: 'pi-compatible'
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
  },
  devin: {
    workingLabel: 'Devin',
    permissionLabel: 'Devin - action required',
    idleLabel: 'Devin ready'
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
  if (!profile || profile.synthesizeTerminalTitle === false || state === 'working') {
    return null
  }
  return state === 'blocked' || state === 'waiting' ? profile.permissionLabel : profile.idleLabel
}

export function shouldDriveSyntheticAgentTitleFromHook(
  agentType: AgentType | null | undefined,
  state: AgentStatusState
): boolean {
  const profile = getSyntheticAgentTitleProfile(agentType)
  if (!profile || profile.synthesizeTerminalTitle === false) {
    return false
  }
  return state !== 'working' || profile.synthesizeWorkingTitle !== false
}
