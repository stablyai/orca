import type { AgentStatusState, AgentType } from './agent-status-types'
import type { TuiAgent } from './tui-agent'
import { getPiCompatibleSyntheticAgentStatus } from './pi-compatible-synthetic-title'

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
  'devin',
  'zcode'
] as const satisfies readonly TuiAgent[]

export const SYNTHETIC_AGENT_TITLE_PROFILES: Record<string, SyntheticAgentTitleProfile> = {
  codex: {
    workingLabel: 'Codex',
    permissionLabel: 'Codex - action required',
    idleLabel: 'Codex ready',
    // Keep native Codex working/spinner titles; synthesize terminal states when its final OSC frame is missing.
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
    // Preserve OpenCode’s own semantic session titles.
    synthesizeTerminalTitle: false
  },
  pi: {
    workingLabel: 'Pi',
    permissionLabel: 'Pi - action required',
    idleLabel: 'Pi ready',
    titleIdentityGroup: 'pi-compatible',
    // Pi animates working titles every 80ms with session labels; synthesis fights those frames.
    // Synthesize terminal states because Pi is quiet at rest and pane identity still needs a title.
    synthesizeWorkingTitle: false
  },
  omp: {
    workingLabel: 'OMP',
    permissionLabel: 'OMP - action required',
    idleLabel: 'OMP ready',
    titleIdentityGroup: 'pi-compatible',
    // OMP and Orca’s titlebar extension (main/pi/titlebar-extension-source.ts) title the session; synthesis would erase its name.
    synthesizeTerminalTitle: false
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
  },
  zcode: {
    workingLabel: 'ZCode',
    permissionLabel: 'ZCode - action required',
    idleLabel: 'ZCode ready',
    // Captured zcode-composer-ready.txt has no OSC 0/1/2; synthesize every state for tui-idle detection.
    // Its endlessly repainting ASCII banner also prevents quiescence detection.
    synthesizeWorkingTitle: true
  }
}

const SYNTHETIC_PERMISSION_TITLES: ReadonlySet<string> = new Set(
  Object.values(SYNTHETIC_AGENT_TITLE_PROFILES)
    .filter((profile) => profile.synthesizeTerminalTitle !== false)
    .map((profile) => profile.permissionLabel.toLowerCase())
)

export function isSyntheticAgentPermissionTitle(title: string): boolean {
  // Older hosts still write `OMP - action required`, which OMP's own π titles never match.
  return (
    SYNTHETIC_PERMISSION_TITLES.has(title.trim().toLowerCase()) ||
    getPiCompatibleSyntheticAgentStatus(title) === 'permission'
  )
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
