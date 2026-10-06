import type { AgentProfileSnapshot } from './agent-launch-profile'

export type SleepingAgentLaunchConfig = {
  // null captures system auth; absent means legacy managed or uncaptured ownership.
  claudeAccountId?: string | null
  agentProfile?: AgentProfileSnapshot
  agentCommand?: string
  agentArgs: string
  agentEnv: Record<string, string>
  ompResumeFilePath?: string
}
