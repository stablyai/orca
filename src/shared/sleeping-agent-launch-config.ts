import type { SleepingAgentLaunchConfig } from './agent-session-resume'
import { getAgentSessionOptionCatalog } from './agent-session-option-catalog'
import type { TuiAgent } from './tui-agent'

export function sleepingAgentCommand(
  agent: TuiAgent,
  baseCommand: { command: string; commandWithoutSessionOptions: string }
): string {
  return getAgentSessionOptionCatalog(agent)?.capturesOptionsInLaunchCommand
    ? baseCommand.command
    : baseCommand.commandWithoutSessionOptions
}

export function buildSleepingAgentLaunchConfig(args: {
  agentCommand?: string | null
  agentArgs?: string | null
  agentEnv?: Record<string, string> | null
  ompResumeFilePath?: string | null
}): SleepingAgentLaunchConfig {
  return {
    ...(args.agentCommand?.trim() ? { agentCommand: args.agentCommand } : {}),
    agentArgs: args.agentArgs ?? '',
    // Why: startup env may include prompt transport or pane identity values;
    // durable resume state is limited to Orca-managed agent inputs.
    agentEnv: args.agentEnv ? { ...args.agentEnv } : {},
    ...(args.ompResumeFilePath?.trim() ? { ompResumeFilePath: args.ompResumeFilePath.trim() } : {})
  }
}
