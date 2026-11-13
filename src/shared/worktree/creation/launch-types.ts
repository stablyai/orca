import type { StartupCommandDelivery } from '../../agent-launch/startup/codex-startup-delivery'
import type { AgentKind, LaunchSource, RequestKind } from '../../telemetry-property-schemas'
import type { SleepingAgentLaunchConfig } from '../../agent-session/lifecycle/agent-session-resume'
import type { SetupRunnerShell } from '../../agent-launch/startup/setup-runner-command'
import type { OrcaDefaultTabTemplate } from '../../orca-yaml-hook-types'
import type { TuiAgent } from '../../agent-launch/catalog/tui-agent'

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
