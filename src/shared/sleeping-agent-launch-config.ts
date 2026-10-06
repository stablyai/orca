import { copyAgentProfileSnapshot } from './agent-launch-profile'
import type { SleepingAgentLaunchConfig } from './agent-session-resume'

export function buildSleepingAgentLaunchConfig(args: {
  agentProfile?: SleepingAgentLaunchConfig['agentProfile']
  claudeAccountId?: string | null
  agentCommand?: string | null
  agentArgs?: string | null
  agentEnv?: Record<string, string> | null
  ompResumeFilePath?: string | null
}): SleepingAgentLaunchConfig {
  return {
    ...(args.agentProfile !== undefined
      ? { agentProfile: copyAgentProfileSnapshot(args.agentProfile) }
      : {}),
    ...(args.claudeAccountId !== undefined ? { claudeAccountId: args.claudeAccountId } : {}),
    ...(args.agentCommand?.trim() ? { agentCommand: args.agentCommand } : {}),
    agentArgs: args.agentArgs ?? '',
    // Why: startup env may include prompt transport or pane identity values;
    // durable resume state is limited to Orca-managed agent inputs.
    agentEnv: args.agentEnv ? { ...args.agentEnv } : {},
    ...(args.ompResumeFilePath?.trim() ? { ompResumeFilePath: args.ompResumeFilePath.trim() } : {})
  }
}
