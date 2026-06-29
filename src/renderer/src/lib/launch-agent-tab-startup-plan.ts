import {
  buildAgentDraftLaunchPlan,
  buildAgentStartupPlan,
  type AgentStartupPlan
} from '@/lib/tui-agent-startup'
import { TUI_AGENT_CONFIG } from '../../../shared/tui-agent-config'
import { resolveTuiAgentBaseAgent } from '../../../shared/tui-agent-profiles'
import type { StartupCommandDelivery } from '../../../shared/codex-startup-delivery'
import type { TuiAgent, TuiAgentProfile } from '../../../shared/types'

type PromptDelivery = 'auto-submit' | 'draft' | 'submit-after-ready'

export type LaunchAgentTabStartupPlan = {
  startupPlan: AgentStartupPlan | null
  pasteDraftAfterLaunch: string | null
  submitPastedPrompt: boolean
  forcePasteAfterLaunch: boolean
}

export function buildLaunchAgentTabStartupPlan(args: {
  agent: TuiAgent
  prompt: string | null | undefined
  promptDelivery: PromptDelivery
  cmdOverrides: Partial<Record<TuiAgent, string>>
  platform: NodeJS.Platform
  agentArgs: string
  agentEnv: Record<string, string>
  agentProfiles: readonly TuiAgentProfile[]
  variables: { repoPath?: string | null; worktreePath?: string | null }
  isRemote?: boolean
}): LaunchAgentTabStartupPlan {
  const trimmedPrompt = args.prompt?.trim() ?? ''
  const hasPrompt = trimmedPrompt.length > 0
  const baseAgent = resolveTuiAgentBaseAgent(args.agent, args.agentProfiles)
  const isFollowupPath = baseAgent
    ? TUI_AGENT_CONFIG[baseAgent].promptInjectionMode === 'stdin-after-start'
    : false
  const common = {
    agent: args.agent,
    cmdOverrides: args.cmdOverrides,
    platform: args.platform,
    agentArgs: args.agentArgs,
    agentEnv: args.agentEnv,
    agentProfiles: args.agentProfiles,
    variables: args.variables,
    isRemote: args.isRemote
  }

  if (hasPrompt && args.promptDelivery === 'submit-after-ready') {
    return {
      startupPlan: buildAgentStartupPlan({
        ...common,
        prompt: '',
        allowEmptyPromptLaunch: true
      }),
      pasteDraftAfterLaunch: trimmedPrompt,
      submitPastedPrompt: true,
      forcePasteAfterLaunch: true
    }
  }

  if (hasPrompt && args.promptDelivery === 'draft') {
    const draftLaunchPlan = buildAgentDraftLaunchPlan({
      ...common,
      draft: trimmedPrompt
    })
    if (draftLaunchPlan) {
      return {
        startupPlan: draftPlanToStartupPlan(draftLaunchPlan),
        pasteDraftAfterLaunch: null,
        submitPastedPrompt: false,
        forcePasteAfterLaunch: false
      }
    }
    return {
      startupPlan: buildAgentStartupPlan({
        ...common,
        prompt: '',
        allowEmptyPromptLaunch: true
      }),
      pasteDraftAfterLaunch: trimmedPrompt,
      submitPastedPrompt: false,
      forcePasteAfterLaunch: false
    }
  }

  if (hasPrompt && isFollowupPath) {
    return {
      startupPlan: buildAgentStartupPlan({
        ...common,
        prompt: '',
        allowEmptyPromptLaunch: true
      }),
      pasteDraftAfterLaunch: trimmedPrompt,
      submitPastedPrompt: false,
      forcePasteAfterLaunch: false
    }
  }

  return {
    startupPlan: buildAgentStartupPlan({
      ...common,
      prompt: hasPrompt ? trimmedPrompt : '',
      allowEmptyPromptLaunch: !hasPrompt
    }),
    pasteDraftAfterLaunch: null,
    submitPastedPrompt: false,
    forcePasteAfterLaunch: false
  }
}

export function draftPlanToStartupPlan(plan: {
  agent: TuiAgent
  launchCommand: string
  expectedProcess: string
  launchConfig: AgentStartupPlan['launchConfig']
  env?: Record<string, string>
  startupCommandDelivery?: StartupCommandDelivery
}): AgentStartupPlan {
  return {
    agent: plan.agent,
    launchCommand: plan.launchCommand,
    expectedProcess: plan.expectedProcess,
    followupPrompt: null,
    launchConfig: plan.launchConfig,
    ...(plan.startupCommandDelivery ? { startupCommandDelivery: plan.startupCommandDelivery } : {}),
    ...(plan.env ? { env: plan.env } : {})
  }
}
