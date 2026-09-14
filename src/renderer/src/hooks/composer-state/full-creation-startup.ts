import type { TuiAgent } from '../../../../shared/tui-agent'
import type { AgentStartupPlan } from '@/lib/tui-agent-startup'
import type { WorktreeStartupPayload } from '@/lib/worktree-startup-payload'

export function buildFullCreationStartup(args: {
  startupPlan: AgentStartupPlan | null
  backendSpawnedStartup: boolean
  agent: TuiAgent
  shouldSeedInitialAgentStatus: boolean
  prompt: string
  telemetry: WorktreeStartupPayload['telemetry']
}): WorktreeStartupPayload | undefined {
  if (!args.startupPlan || args.backendSpawnedStartup) {
    return undefined
  }
  return {
    command: args.startupPlan.launchCommand,
    ...(args.startupPlan.env ? { env: args.startupPlan.env } : {}),
    launchConfig: args.startupPlan.launchConfig,
    ...(args.startupPlan.launchToken ? { launchToken: args.startupPlan.launchToken } : {}),
    launchAgent: args.agent,
    ...(args.startupPlan.draftPrompt ? { draftPrompt: args.startupPlan.draftPrompt } : {}),
    ...(args.startupPlan.startupCommandDelivery
      ? { startupCommandDelivery: args.startupPlan.startupCommandDelivery }
      : {}),
    ...(args.shouldSeedInitialAgentStatus
      ? { initialAgentStatus: { agent: args.agent, prompt: args.prompt.trim() } }
      : {}),
    telemetry: args.telemetry
  }
}
