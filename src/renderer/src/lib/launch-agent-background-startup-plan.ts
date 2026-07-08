import { buildAgentStartupPlan, type AgentStartupPlan } from '@/lib/tui-agent-startup'
import { TUI_AGENT_CONFIG } from '../../../shared/tui-agent-config'
import {
  resolveTuiAgentBaseAgent,
  type TuiAgentProfileVariables
} from '../../../shared/tui-agent-profiles'
import type { TuiAgent, TuiAgentProfile } from '../../../shared/types'

export type BackgroundAgentStartupPlanResult = {
  startupPlan: AgentStartupPlan | null
  pasteDraftAfterLaunch: string | null
  trimmedPrompt: string
  hasPrompt: boolean
  isFollowupPath: boolean
}

export function buildBackgroundAgentStartupPlan(args: {
  agent: TuiAgent
  prompt?: string | null
  cmdOverrides: Partial<Record<TuiAgent, string>>
  agentArgs: string | null
  agentEnv: Record<string, string>
  agentProfiles: readonly TuiAgentProfile[]
  variables: TuiAgentProfileVariables
  platform: NodeJS.Platform
  isRemote: boolean
}): BackgroundAgentStartupPlanResult {
  const baseAgent = resolveTuiAgentBaseAgent(args.agent, args.agentProfiles)
  const trimmedPrompt = args.prompt?.trim() ?? ''
  const hasPrompt = trimmedPrompt.length > 0
  const isFollowupPath = baseAgent
    ? TUI_AGENT_CONFIG[baseAgent].promptInjectionMode === 'stdin-after-start'
    : false

  if (hasPrompt && isFollowupPath) {
    return {
      startupPlan: buildAgentStartupPlan({
        agent: args.agent,
        prompt: '',
        cmdOverrides: args.cmdOverrides,
        agentArgs: args.agentArgs,
        agentEnv: args.agentEnv,
        agentProfiles: args.agentProfiles,
        variables: args.variables,
        platform: args.platform,
        isRemote: args.isRemote,
        allowEmptyPromptLaunch: true
      }),
      pasteDraftAfterLaunch: trimmedPrompt,
      trimmedPrompt,
      hasPrompt,
      isFollowupPath
    }
  }

  return {
    startupPlan: buildAgentStartupPlan({
      agent: args.agent,
      prompt: hasPrompt ? trimmedPrompt : '',
      cmdOverrides: args.cmdOverrides,
      agentArgs: args.agentArgs,
      agentEnv: args.agentEnv,
      agentProfiles: args.agentProfiles,
      variables: args.variables,
      platform: args.platform,
      isRemote: args.isRemote,
      allowEmptyPromptLaunch: !hasPrompt
    }),
    pasteDraftAfterLaunch: null,
    trimmedPrompt,
    hasPrompt,
    isFollowupPath
  }
}
