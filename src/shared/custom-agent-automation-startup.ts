import {
  buildAgentStartupPlan,
  resolveStartupShell,
  type AgentStartupPlan
} from './tui-agent-startup'
import type { AgentStartupShell } from './tui-agent-startup-shell'
import { buildShellCommandFromArgv, quoteStartupArg } from './tui-agent-startup-shell'
import { buildSleepingAgentLaunchConfig } from './sleeping-agent-launch-config'
import { planHermesStartupQuery } from './hermes-startup-query'
import { TUI_AGENT_CONFIG } from './tui-agent-config'
import {
  buildCustomAgentLaunch,
  type CustomAgentProfile,
  type CustomAgentLaunch
} from './custom-agent-profile'

type AutomationAgentStartupPlanArgs = Parameters<typeof buildAgentStartupPlan>[0] & {
  customAgentProfile?: CustomAgentProfile
}

function serializedArgs(profile: CustomAgentProfile, shell: AgentStartupShell): string {
  return profile.args.map((arg) => quoteStartupArg(arg, shell)).join(' ')
}

export function buildCustomAgentAutomationStartupPlan(args: {
  profile: CustomAgentProfile
  prompt: string
  platform: NodeJS.Platform
  shell: AgentStartupShell
}): AgentStartupPlan | null {
  const { profile, platform, shell } = args
  if (!profile.baseAgent) {
    return null
  }
  const agent = profile.baseAgent
  const config = TUI_AGENT_CONFIG[agent]
  const prompt = args.prompt.trim()
  const launchConfig = buildSleepingAgentLaunchConfig({
    agentCommand: buildShellCommandFromArgv([profile.executable], shell),
    agentArgs: serializedArgs(profile, shell),
    agentEnv: {}
  })
  let launch: CustomAgentLaunch
  let followupPrompt: string | null = null

  if (!prompt) {
    launch = buildCustomAgentLaunch(profile, shell)
  } else if (config.promptInjectionMode === 'hermes-query') {
    const query = planHermesStartupQuery({
      baseCommand: buildShellCommandFromArgv([profile.executable], shell),
      agentArgs: serializedArgs(profile, shell),
      prompt,
      platform,
      shell
    })
    if (!query) {
      return null
    }
    launch = { command: query.command, env: query.env }
  } else if (config.promptInjectionMode === 'stdin-after-start') {
    launch = buildCustomAgentLaunch(profile, shell)
    followupPrompt = prompt
  } else {
    const promptArgs =
      config.promptInjectionMode === 'argv'
        ? [...(config.argvPromptSeparator ? [config.argvPromptSeparator] : []), prompt]
        : config.promptInjectionMode === 'flag-prompt'
          ? ['--prompt', prompt]
          : config.promptInjectionMode === 'flag-prompt-interactive'
            ? ['--prompt-interactive', prompt]
            : ['-i', prompt]
    launch = buildCustomAgentLaunch(profile, shell, promptArgs)
  }

  return {
    agent,
    launchCommand: launch.command,
    expectedProcess: config.expectedProcess,
    followupPrompt,
    launchConfig,
    ...(launch.env ? { env: launch.env } : {}),
    ...(agent === 'codex' && prompt ? { startupCommandDelivery: 'shell-ready' as const } : {})
  }
}

export function buildAutomationAgentStartupPlan({
  customAgentProfile,
  ...args
}: AutomationAgentStartupPlanArgs): AgentStartupPlan | null {
  if (!customAgentProfile) {
    return buildAgentStartupPlan(args)
  }
  if (customAgentProfile.baseAgent !== args.agent) {
    return null
  }
  return buildCustomAgentAutomationStartupPlan({
    profile: customAgentProfile,
    prompt: args.prompt,
    platform: args.platform,
    shell: resolveStartupShell(args.platform, args.shell)
  })
}
