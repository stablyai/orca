import type { SleepingAgentLaunchConfig } from './agent-session-resume'
import { buildSleepingAgentLaunchConfig } from './sleeping-agent-launch-config'
import type { AgentStartupShell } from './tui-agent-startup-shell'
import type { TuiAgent } from './types'

export function buildTuiAgentLaunchConfig(args: {
  agent: TuiAgent
  platform: NodeJS.Platform
  shell: AgentStartupShell
  isRemote?: boolean
  usesDefaultCommand: boolean
  agentCommand?: string | null
  agentArgs?: string | null
  agentEnv?: Record<string, string> | null
}): SleepingAgentLaunchConfig {
  // Why: argv handoff may reinterpret only Orca's stock local Codex launch;
  // custom commands and remote shells must retain their existing semantics.
  const useWindowsCodexShellHandoff =
    args.agent === 'codex' &&
    args.platform === 'win32' &&
    args.shell === 'powershell' &&
    args.isRemote !== true &&
    args.usesDefaultCommand
  return buildSleepingAgentLaunchConfig({
    agentCommand: args.agentCommand,
    agentArgs: args.agentArgs,
    agentEnv: args.agentEnv,
    ...(useWindowsCodexShellHandoff ? { windowsCodexShellHandoff: true } : {})
  })
}
