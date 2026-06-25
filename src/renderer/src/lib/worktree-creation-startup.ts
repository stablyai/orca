import {
  resolveTuiAgentLaunchArgs,
  resolveTuiAgentLaunchEnv,
} from '../../../shared/tui-agent-launch-defaults'
import type { WorktreeStartupPayload } from '@/lib/worktree-activation'
import {
  buildAgentDraftLaunchPlan,
  buildAgentStartupPlan,
  type AgentStartupPlan,
} from './tui-agent-startup'
import { draftPlanToStartupPlan } from './launch-agent-tab-startup-plan'
import type { WorktreeCreationRequest } from '@/lib/pending-worktree-creation'

// Why: mirrors the startup-opt the composer used to build inline. The renderer
// only seeds the first terminal when the backend did not already spawn it.
export function buildWorktreeCreationStartupPayload(
  request: WorktreeCreationRequest,
  backendSpawned: boolean,
  startupPlan: AgentStartupPlan | null,
): WorktreeStartupPayload | undefined {
  const plan = startupPlan
  if (!plan || backendSpawned) {
    return undefined
  }
  return {
    command: plan.launchCommand,
    ...(plan.env ? { env: plan.env } : {}),
    launchConfig: plan.launchConfig,
    ...(plan.launchToken ? { launchToken: plan.launchToken } : {}),
    ...(request.agent ? { launchAgent: request.agent } : {}),
    ...(plan.startupCommandDelivery
      ? { startupCommandDelivery: plan.startupCommandDelivery }
      : {}),
    ...(request.agent === 'command-code' && request.quickPrompt.trim().length > 0
      ? {
          initialAgentStatus: {
            agent: request.agent,
            prompt: request.quickPrompt.trim(),
          },
        }
      : {}),
    ...(request.quickTelemetry ? { telemetry: request.quickTelemetry } : {}),
  }
}

export function buildPostCreateStartupPlan(
  request: WorktreeCreationRequest,
  repoPath: string | null | undefined,
  worktreePath: string | null | undefined,
): AgentStartupPlan | null {
  const template = request.startupPlanTemplate
  if (!template) {
    return request.startupPlan
  }
  const variables = { repoPath, worktreePath }
  const agentArgs = resolveTuiAgentLaunchArgs(
    template.agent,
    template.agentDefaultArgs,
    template.agentProfiles,
    variables,
  )
  const agentEnv = resolveTuiAgentLaunchEnv(
    template.agent,
    template.agentDefaultEnv,
    template.agentProfiles,
    variables,
  )
  const common = {
    agent: template.agent,
    cmdOverrides: template.cmdOverrides,
    agentArgs,
    agentEnv,
    agentProfiles: template.agentProfiles,
    variables,
    platform: template.platform,
  }

  if (template.draftPrompt) {
    const draftPlan = buildAgentDraftLaunchPlan({
      ...common,
      draft: template.draftPrompt,
    })
    if (draftPlan) {
      return draftPlanToStartupPlan(draftPlan)
    }
  }

  const startupPlan = buildAgentStartupPlan({
    ...common,
    prompt: template.prompt,
    allowEmptyPromptLaunch: template.allowEmptyPromptLaunch,
  })
  if (startupPlan && template.draftPrompt) {
    startupPlan.draftPrompt = template.draftPrompt
  }
  return startupPlan
}
