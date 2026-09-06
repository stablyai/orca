import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { TuiAgent } from '../../../shared/tui-agent'
import type { WorktreeStartupLaunch } from '../../../shared/worktree/launch-types'
import { buildAutomationShellStartup } from '../../../shared/automation-shell-startup'
import { TUI_AGENT_CONFIG } from '../../../shared/tui-agent-config'
import {
  buildAgentStartupPlan,
  resolveStartupShell,
  type AgentStartupPlan
} from './tui-agent-startup'
import {
  resolveTuiAgentLaunchArgs,
  resolveTuiAgentLaunchEnv
} from '../../../shared/tui-agent-launch-defaults'
import { resolveLocalWindowsAgentStartupShell } from '../../../shared/windows-terminal-shell'

export function buildBackgroundSessionStartup(args: {
  agent: TuiAgent | null
  prompt: string
  settings: GlobalSettings | null
  platform: NodeJS.Platform
  isRemote: boolean
}): {
  startupPlan: AgentStartupPlan | null
  startup: WorktreeStartupLaunch
  pasteDraftAfterLaunch: string | null
} | null {
  const { agent, prompt, settings, platform, isRemote } = args
  const shell = resolveLocalWindowsAgentStartupShell({
    platform,
    isRemote,
    terminalWindowsShell: settings?.terminalWindowsShell
  })
  const hasPrompt = prompt.length > 0
  const isFollowup =
    agent !== null && TUI_AGENT_CONFIG[agent].promptInjectionMode === 'stdin-after-start'
  const startupPlan = agent
    ? buildAgentStartupPlan({
        agent,
        prompt: hasPrompt && !isFollowup ? prompt : '',
        cmdOverrides: settings?.agentCmdOverrides ?? {},
        agentArgs: resolveTuiAgentLaunchArgs(agent, settings?.agentDefaultArgs),
        agentEnv: resolveTuiAgentLaunchEnv(agent, settings?.agentDefaultEnv),
        platform,
        shell,
        isRemote,
        allowEmptyPromptLaunch: !hasPrompt || isFollowup
      })
    : null
  if ((agent && !startupPlan) || (!agent && !hasPrompt)) {
    return null
  }
  return {
    startupPlan,
    startup: startupPlan
      ? {
          command: startupPlan.launchCommand,
          env: startupPlan.env,
          launchConfig: startupPlan.launchConfig,
          startupCommandDelivery: startupPlan.startupCommandDelivery
        }
      : buildAutomationShellStartup(prompt, resolveStartupShell(platform, shell)),
    pasteDraftAfterLaunch: hasPrompt && isFollowup ? prompt : null
  }
}
