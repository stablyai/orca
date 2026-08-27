import type { StartupCommandDelivery } from '../codex-startup-delivery'
import type { AgentKind, LaunchSource, RequestKind } from '../telemetry-events'
import type { SleepingAgentLaunchConfig } from '../agent-session-resume'
import type { SetupRunnerShell } from '../setup-runner-command'
import type { OrcaDefaultTabTemplate } from '../orca-yaml-hook-types'
import type { TuiAgent } from '../tui-agent'

export type WorktreeSetupLaunch = {
  runnerScriptPath: string
  envVars: Record<string, string>
  shell?: SetupRunnerShell
  command?: string
  waitForAgentStartup?: boolean
}

export type WorktreeStartupLaunch = {
  command: string
  env?: Record<string, string>
  launchConfig?: SleepingAgentLaunchConfig
  launchToken?: string
  launchAgent?: TuiAgent
  viewMode?: 'terminal' | 'chat'
  startupCommandDelivery?: StartupCommandDelivery
  telemetry?: { agent_kind: AgentKind; launch_source: LaunchSource; request_kind: RequestKind }
}

export type WorktreeDefaultTabsLaunch = {
  tabs: OrcaDefaultTabTemplate[]
  runCommands: boolean
}

/** Where the repo setup script runs when a worktree is created.
 *  - 'new-tab': open a background tab titled "Setup" and leave focus on the first tab (default).
 *  - 'split-vertical': split the initial terminal pane with a vertical divider.
 *  - 'split-horizontal': split the initial terminal pane with a horizontal divider. */
export type SetupScriptLaunchMode = 'split-vertical' | 'split-horizontal' | 'new-tab'

/** Direction used when the setup script launch mode is a split. */
export type SetupSplitDirection = 'vertical' | 'horizontal'
