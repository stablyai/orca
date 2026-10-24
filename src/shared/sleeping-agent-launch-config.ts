import type { SleepingAgentLaunchConfig } from './agent-session-resume'
import { isLaunchConfigClaudeAccountId } from './claude/project-claude-account-preference'

export function buildSleepingAgentLaunchConfig(args: {
  agentCommand?: string | null
  agentArgs?: string | null
  agentEnv?: Record<string, string> | null
  ompResumeFilePath?: string | null
  claudeAccountId?: string | null
}): SleepingAgentLaunchConfig {
  return {
    ...(args.agentCommand?.trim() ? { agentCommand: args.agentCommand } : {}),
    agentArgs: args.agentArgs ?? '',
    // Why: startup env may include prompt transport or pane identity values;
    // durable resume state is limited to Orca-managed agent inputs.
    agentEnv: args.agentEnv ? { ...args.agentEnv } : {},
    ...(args.ompResumeFilePath?.trim() ? { ompResumeFilePath: args.ompResumeFilePath.trim() } : {}),
    ...(isLaunchConfigClaudeAccountId(args.claudeAccountId)
      ? { claudeAccountId: args.claudeAccountId }
      : {})
  }
}
