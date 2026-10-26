import type { AgentStartupSettings } from './agent-startup-plan-inputs'
import type { SleepingAgentLaunchConfig } from './agent-session-resume'
import type { TuiAgent } from './tui-agent'

/** Recipe provenance survives transport until the execution host composes account env. */
export type AgentTerminalResume = {
  recipe:
    | { source: 'host-defaults' }
    | { source: 'current-inputs'; settings: AgentStartupSettings; agentArgs?: string | null }
    | { source: 'saved'; launchConfig?: SleepingAgentLaunchConfig }
  ompResumeFilePath?: string
  resumeInLaunchCwd?: boolean
  codexHome?: string | null
}

export const AGENT_RESUME_HOST_PLAN_CAPABILITY = 'agent-resume.host-plan.v1' as const

function selectedAgentInput<T>(values: Partial<Record<TuiAgent, T>> | undefined, agent: TuiAgent) {
  const value = values?.[agent]
  return value === undefined ? undefined : { [agent]: value }
}

/** Project before cloning: unrelated agent profiles cannot enlarge or refuse a History drag. */
export function agentResumeCurrentInputs(
  agent: TuiAgent,
  settings: AgentStartupSettings | null | undefined
): AgentStartupSettings {
  return structuredClone({
    agentCmdOverrides: selectedAgentInput(settings?.agentCmdOverrides, agent),
    agentDefaultArgs: selectedAgentInput(settings?.agentDefaultArgs, agent),
    agentDefaultEnv: selectedAgentInput(settings?.agentDefaultEnv, agent),
    agentPermissionDefault: settings?.agentPermissionDefault,
    agentPermissionOverrides: selectedAgentInput(settings?.agentPermissionOverrides, agent)
  })
}

export type TerminalStartupInput =
  | { command: string; resume?: never }
  | { command?: never; resume: AgentTerminalResume }
