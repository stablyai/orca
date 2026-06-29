import {
  buildAgentDraftLaunchPlan,
  buildAgentStartupPlan,
  type AgentStartupPlan
} from '@/lib/tui-agent-startup'
import type { AgentStartupTarget } from '@/lib/agent-startup-target'
import { TUI_AGENT_CONFIG } from '../../../shared/tui-agent-config'
import type { GlobalSettings, TuiAgent } from '../../../shared/types'
import {
  resolveTuiAgentLaunchArgs,
  resolveTuiAgentLaunchEnv
} from '../../../shared/tui-agent-launch-defaults'

type LaunchAgentInNewTabStartupSettings = Partial<
  Pick<
    GlobalSettings,
    'agentCmdOverrides' | 'agentDefaultArgs' | 'agentDefaultEnv' | 'terminalWindowsShell'
  >
>

export type LaunchAgentInNewTabStartupResult = {
  startupPlan: AgentStartupPlan
  trimmedPrompt: string
  hasPrompt: boolean
  pasteDraftAfterLaunch: string | null
  submitPastedPrompt: boolean
  forcePasteAfterLaunch: boolean
}

export function buildLaunchAgentInNewTabStartup(args: {
  agent: TuiAgent
  prompt?: string
  agentArgs?: string | null
  promptDelivery: 'auto-submit' | 'draft' | 'submit-after-ready'
  startupTarget: AgentStartupTarget
  isRemote?: boolean
  settings?: LaunchAgentInNewTabStartupSettings | null
}): LaunchAgentInNewTabStartupResult | null {
  const cmdOverrides = args.settings?.agentCmdOverrides ?? {}
  const { platform, shell } = args.startupTarget
  const effectiveAgentArgs =
    args.agentArgs !== undefined
      ? args.agentArgs
      : resolveTuiAgentLaunchArgs(args.agent, args.settings?.agentDefaultArgs)
  const agentEnv = resolveTuiAgentLaunchEnv(args.agent, args.settings?.agentDefaultEnv)
  const trimmedPrompt = args.prompt?.trim() ?? ''
  const hasPrompt = trimmedPrompt.length > 0
  const isFollowupPath = TUI_AGENT_CONFIG[args.agent].promptInjectionMode === 'stdin-after-start'
  let startupPlan: AgentStartupPlan | null = null
  let pasteDraftAfterLaunch: string | null = null
  let submitPastedPrompt = false
  let forcePasteAfterLaunch = false

  if (hasPrompt && args.promptDelivery === 'submit-after-ready') {
    // Why: generated prompts may be too large to echo through shell argv.
    startupPlan = buildAgentStartupPlan({
      agent: args.agent,
      prompt: '',
      cmdOverrides,
      platform,
      shell,
      isRemote: args.isRemote,
      agentArgs: effectiveAgentArgs,
      agentEnv,
      allowEmptyPromptLaunch: true
    })
    pasteDraftAfterLaunch = trimmedPrompt
    submitPastedPrompt = true
    forcePasteAfterLaunch = true
  } else if (hasPrompt && args.promptDelivery === 'draft') {
    const draftLaunchPlan = buildAgentDraftLaunchPlan({
      agent: args.agent,
      draft: trimmedPrompt,
      cmdOverrides,
      platform,
      shell,
      isRemote: args.isRemote,
      agentArgs: effectiveAgentArgs,
      agentEnv
    })
    if (draftLaunchPlan) {
      startupPlan = {
        agent: draftLaunchPlan.agent,
        launchCommand: draftLaunchPlan.launchCommand,
        ...(draftLaunchPlan.unwrappedLaunchCommand
          ? { unwrappedLaunchCommand: draftLaunchPlan.unwrappedLaunchCommand }
          : {}),
        expectedProcess: draftLaunchPlan.expectedProcess,
        followupPrompt: null,
        launchConfig: draftLaunchPlan.launchConfig,
        ...(draftLaunchPlan.startupCommandDelivery
          ? { startupCommandDelivery: draftLaunchPlan.startupCommandDelivery }
          : {}),
        ...(draftLaunchPlan.env ? { env: draftLaunchPlan.env } : {})
      }
    } else {
      startupPlan = buildAgentStartupPlan({
        agent: args.agent,
        prompt: '',
        cmdOverrides,
        platform,
        shell,
        isRemote: args.isRemote,
        agentArgs: effectiveAgentArgs,
        agentEnv,
        allowEmptyPromptLaunch: true
      })
      pasteDraftAfterLaunch = trimmedPrompt
    }
  } else if (hasPrompt && isFollowupPath) {
    startupPlan = buildAgentStartupPlan({
      agent: args.agent,
      prompt: '',
      cmdOverrides,
      platform,
      shell,
      isRemote: args.isRemote,
      agentArgs: effectiveAgentArgs,
      agentEnv,
      allowEmptyPromptLaunch: true
    })
    pasteDraftAfterLaunch = trimmedPrompt
  } else {
    startupPlan = buildAgentStartupPlan({
      agent: args.agent,
      prompt: hasPrompt ? trimmedPrompt : '',
      cmdOverrides,
      platform,
      shell,
      isRemote: args.isRemote,
      agentArgs: effectiveAgentArgs,
      agentEnv,
      allowEmptyPromptLaunch: !hasPrompt
    })
  }

  return startupPlan
    ? {
        startupPlan,
        trimmedPrompt,
        hasPrompt,
        pasteDraftAfterLaunch,
        submitPastedPrompt,
        forcePasteAfterLaunch
      }
    : null
}
