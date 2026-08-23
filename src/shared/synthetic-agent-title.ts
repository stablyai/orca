import type { AgentStatusState, AgentType } from './agent-status-types'

/** Labels and title-driving flags used to synthesize a terminal title for an agent. */
export type SyntheticAgentTitleProfile = {
  workingLabel: string
  permissionLabel: string
  idleLabel: string
  titleIdentityGroup?: string
  synthesizeTerminalTitle?: boolean
  synthesizeWorkingTitle?: boolean
}

/** Title profiles keyed by agent type; unknown types synthesize no titles. */
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
    titleIdentityGroup: 'pi-compatible'
  },
  'prime-agent': {
    workingLabel: 'Prime Agent',
    permissionLabel: 'Prime Agent - action required',
    idleLabel: 'Prime Agent ready',
    titleIdentityGroup: 'pi-compatible'
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

/** Resolves the synthetic title profile for an agent type, or null when the
 *  agent type is missing or has no profile (no synthesized titles). */
export function getSyntheticAgentTitleProfile(
  agentType: AgentType | null | undefined
): SyntheticAgentTitleProfile | null {
  if (!agentType) {
    return null
  }
  return SYNTHETIC_AGENT_TITLE_PROFILES[agentType] ?? null
}

/** Returns the terminal title to synthesize for an agent state, or null when
 *  the agent owns its native titles (OpenCode session titles), is actively
 *  working (Codex spinner), or has no profile.
 *  @param agentType - The agent whose terminal title should be synthesized.
 *  @param state - The agent status state driving the synthesized title.
 *  @returns The synthesized title, or null when the agent/state should not get
 *    a synthesized title. */
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

/** Whether hook status updates should drive the synthesized terminal title
 *  for the given agent state. False for agents that own native title behavior
 *  (OpenCode, or Codex while the native spinner runs).
 *  @param agentType - The agent whose title hook handling is queried.
 *  @param state - The agent status state being evaluated.
 *  @returns True when the hook should drive the synthesized title. */
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
