import { buildAgentStartupPlan, type AgentStartupPlan } from '@/lib/tui-agent-startup'
import {
  resolveTuiAgentLaunchArgs,
  resolveTuiAgentLaunchEnv
} from '../../../shared/tui-agent-launch-defaults'
import { TUI_AGENT_CONFIG } from '../../../shared/tui-agent-config'
import type { GlobalSettings, TuiAgent } from '../../../shared/types'
import type { AgentStartupShell } from '../../../shared/tui-agent-startup-shell'

type BackgroundAgentSettings = Pick<
  GlobalSettings,
  'agentCmdOverrides' | 'agentDefaultArgs' | 'agentDefaultEnv'
>

export function buildBackgroundAgentStartupPlan(args: {
  agent: TuiAgent
  prompt?: string
  settings?: BackgroundAgentSettings | null
  launchPlatform: NodeJS.Platform
  startupShell?: AgentStartupShell
  isRemote: boolean
}): { startupPlan: AgentStartupPlan | null; pasteDraftAfterLaunch: string | null } {
  const trimmedPrompt = args.prompt?.trim() ?? ''
  const hasPrompt = trimmedPrompt.length > 0
  const isFollowupPath = TUI_AGENT_CONFIG[args.agent].promptInjectionMode === 'stdin-after-start'
  return {
    startupPlan: buildAgentStartupPlan({
      agent: args.agent,
      prompt: hasPrompt && !isFollowupPath ? trimmedPrompt : '',
      cmdOverrides: args.settings?.agentCmdOverrides ?? {},
      agentArgs: resolveTuiAgentLaunchArgs(args.agent, args.settings?.agentDefaultArgs),
      agentEnv: resolveTuiAgentLaunchEnv(args.agent, args.settings?.agentDefaultEnv),
      platform: args.launchPlatform,
      shell: args.startupShell,
      isRemote: args.isRemote,
      allowEmptyPromptLaunch: !hasPrompt || isFollowupPath
    }),
    pasteDraftAfterLaunch: hasPrompt && isFollowupPath ? trimmedPrompt : null
  }
}
