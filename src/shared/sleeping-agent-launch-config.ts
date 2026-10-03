import type { SleepingAgentLaunchConfig } from './agent-session-resume'

export function buildSleepingAgentLaunchConfig(args: {
  agentCommand?: string | null
  agentArgs?: string | null
  agentEnv?: Record<string, string> | null
  ompResumeFilePath?: string | null
  quickCommandId?: string | null
  quickCommandLabel?: string | null
}): SleepingAgentLaunchConfig {
  return {
    ...(args.agentCommand?.trim() ? { agentCommand: args.agentCommand } : {}),
    agentArgs: args.agentArgs ?? '',
    // Why: startup env may include prompt transport or pane identity values;
    // durable resume state is limited to Orca-managed agent inputs.
    agentEnv: args.agentEnv ? { ...args.agentEnv } : {},
    ...(args.ompResumeFilePath?.trim() ? { ompResumeFilePath: args.ompResumeFilePath.trim() } : {}),
    ...(args.quickCommandId?.trim() ? { quickCommandId: args.quickCommandId.trim() } : {}),
    ...(args.quickCommandLabel?.trim() ? { quickCommandLabel: args.quickCommandLabel.trim() } : {})
  }
}
