import type { AgentStatusState, AgentType } from './agent-status-types'
import type { TuiAgent } from './tui-agent'

export type SyntheticAgentTitleProfile = {
  workingLabel: string
  permissionLabel: string
  idleLabel: string
  titleIdentityGroup?: string
  synthesizeTerminalTitle?: boolean
  synthesizeWorkingTitle?: boolean
}

export const SYNTHETIC_AGENT_TITLE_AGENTS = [
  'codex',
  'cursor',
  'opencode',
  'pi',
  'omp',
  'droid',
  'hermes',
  'devin'
] as const satisfies readonly TuiAgent[]

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
    // Why: Pi owns its working OSC title (`π ⠋ <session>`) and animates it itself. Synthesizing
    // over it replaced the session label and fought its frames at 80ms. Terminal states still
    // synthesize: they carry the pane's agent identity downstream, and Pi is quiet at rest.
    synthesizeWorkingTitle: false
  },
  omp: {
    workingLabel: 'OMP',
    permissionLabel: 'OMP - action required',
    idleLabel: 'OMP ready',
    titleIdentityGroup: 'pi-compatible',
    // Why: on an Orca-hosted pane it is Orca's own injected titlebar extension writing the
    // working title (src/main/pi/titlebar-extension-source.ts). See pi above.
    synthesizeWorkingTitle: false
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
