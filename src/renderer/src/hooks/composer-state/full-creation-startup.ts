import type { TuiAgent } from '../../../../shared/tui-agent'
import type { ComposerAgentStartupPlan } from '@/lib/composer-agent-startup-plan'
import type { WorktreeStartupPayload } from '@/lib/worktree-startup-payload'

export function buildFullCreationStartup(args: {
  startupPlan: ComposerAgentStartupPlan | null
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
    // Why: the command points at this file; without it the agent is told to read nothing.
    ...(args.startupPlan.launchFile ? { launchFile: args.startupPlan.launchFile } : {}),
    ...(args.startupPlan.launchPrompt ? { launchPrompt: args.startupPlan.launchPrompt } : {}),
    ...(args.shouldSeedInitialAgentStatus
      ? { initialAgentStatus: { agent: args.agent, prompt: args.prompt.trim() } }
      : {}),
    telemetry: args.telemetry
  }
}
