import { isShellProcess } from './agent-detection'
import {
  getAgentResumeArgv,
  type AgentProviderSessionMetadata,
  type ResumableTuiAgent,
  type SleepingAgentLaunchConfig
} from './agent-session-resume'
import {
  clearEnvCommand,
  commandSeparator,
  planAgentCliArgsSuffix,
  quoteStartupArg,
  resolveStartupShell,
  type AgentStartupShell
} from './tui-agent-startup-shell'
import { getTuiAgentLaunchCommand, TUI_AGENT_CONFIG } from './tui-agent-config'
import type { StartupCommandDelivery } from './codex-startup-delivery'
import type { TuiAgent } from './types'

const WIN32_INLINE_DRAFT_LIMIT_CHARS = 24_000

export type AgentStartupPlan = {
  agent: TuiAgent
  launchCommand: string
  expectedProcess: string
  followupPrompt: string | null
  launchConfig: SleepingAgentLaunchConfig
  draftPrompt?: string | null
  env?: Record<string, string>
  startupCommandDelivery?: StartupCommandDelivery
}

function resolveBaseCommand(args: {
  agent: TuiAgent
  cmdOverrides: Partial<Record<TuiAgent, string>>
  platform: NodeJS.Platform
  shell: AgentStartupShell
  agentArgs?: string | null
}): { ok: true; command: string } | { ok: false; error: string } {
  const override = args.cmdOverrides[args.agent]
  const command = override || getTuiAgentLaunchCommand(TUI_AGENT_CONFIG[args.agent], args.platform)
  const suffix = planAgentCliArgsSuffix(args.agentArgs, args.shell)
  if (!suffix.ok) {
    return suffix
  }
  // Why: Codex status hooks live in Orca's runtime CODEX_HOME; adding
  // --profile-v2 makes Codex load a second hook representation and warn.
  return { ok: true, command: suffix.suffix ? `${command} ${suffix.suffix}` : command }
}

function buildSleepingAgentLaunchConfig(args: {
  agentCommand?: string | null
  agentArgs?: string | null
  agentEnv?: Record<string, string> | null
}): SleepingAgentLaunchConfig {
  return {
    ...(args.agentCommand?.trim() ? { agentCommand: args.agentCommand } : {}),
    agentArgs: args.agentArgs ?? '',
    // Why: startupPlan.env may include prompt transport or pane identity env; the
    // durable resume snapshot is limited to Orca-managed agent env inputs.
    agentEnv: args.agentEnv ? { ...args.agentEnv } : {}
  }
}

export function buildAgentStartupPlan(args: {
  agent: TuiAgent
  prompt: string
  cmdOverrides: Partial<Record<TuiAgent, string>>
  platform: NodeJS.Platform
  shell?: AgentStartupShell
  allowEmptyPromptLaunch?: boolean
  agentArgs?: string | null
  agentEnv?: Record<string, string> | null
}): AgentStartupPlan | null {
  const { agent, prompt, cmdOverrides, platform, allowEmptyPromptLaunch = false } = args
  const shell = resolveStartupShell(platform, args.shell)
  const trimmedPrompt = prompt.trim()
  const config = TUI_AGENT_CONFIG[agent]
  const baseCommand = resolveBaseCommand({
    agent,
    cmdOverrides,
    platform,
    shell,
    agentArgs: args.agentArgs
  })
  if (!baseCommand.ok) {
    return null
  }
  const launchConfig = buildSleepingAgentLaunchConfig({
    ...args,
    agentCommand: baseCommand.command
  })

  if (!trimmedPrompt) {
    if (!allowEmptyPromptLaunch) {
      return null
    }
    return {
      agent,
      launchCommand: baseCommand.command,
      expectedProcess: config.expectedProcess,
      followupPrompt: null,
      launchConfig,
      ...(args.agentEnv ? { env: { ...args.agentEnv } } : {})
    }
  }

  const quotedPrompt = quoteStartupArg(trimmedPrompt, shell)

  if (config.promptInjectionMode === 'argv') {
    return {
      agent,
      launchCommand: `${baseCommand.command} ${quotedPrompt}`,
      expectedProcess: config.expectedProcess,
      followupPrompt: null,
      launchConfig,
      ...(agent === 'codex' ? { startupCommandDelivery: 'shell-ready' as const } : {}),
      ...(args.agentEnv ? { env: { ...args.agentEnv } } : {})
    }
  }

  if (config.promptInjectionMode === 'flag-prompt') {
    return {
      agent,
      launchCommand: `${baseCommand.command} --prompt ${quotedPrompt}`,
      expectedProcess: config.expectedProcess,
      followupPrompt: null,
      launchConfig,
      ...(args.agentEnv ? { env: { ...args.agentEnv } } : {})
    }
  }

  if (config.promptInjectionMode === 'flag-prompt-interactive') {
    return {
      agent,
      launchCommand: `${baseCommand.command} --prompt-interactive ${quotedPrompt}`,
      expectedProcess: config.expectedProcess,
      followupPrompt: null,
      launchConfig,
      ...(args.agentEnv ? { env: { ...args.agentEnv } } : {})
    }
  }

  if (config.promptInjectionMode === 'flag-interactive') {
    return {
      agent,
      launchCommand: `${baseCommand.command} -i ${quotedPrompt}`,
      expectedProcess: config.expectedProcess,
      followupPrompt: null,
      launchConfig,
      ...(args.agentEnv ? { env: { ...args.agentEnv } } : {})
    }
  }

  return {
    agent,
    launchCommand: baseCommand.command,
    expectedProcess: config.expectedProcess,
    followupPrompt: trimmedPrompt,
    launchConfig,
    ...(args.agentEnv ? { env: { ...args.agentEnv } } : {})
  }
}

export function buildAgentResumeStartupPlan(args: {
  agent: ResumableTuiAgent
  providerSession: AgentProviderSessionMetadata
  cmdOverrides: Partial<Record<TuiAgent, string>>
  platform: NodeJS.Platform
  shell?: AgentStartupShell
  agentArgs?: string | null
  agentEnv?: Record<string, string> | null
  agentCommand?: string | null
}): AgentStartupPlan | null {
  const argv = getAgentResumeArgv(args.agent, args.providerSession)
  if (!argv) {
    return null
  }
  const shell = resolveStartupShell(args.platform, args.shell)
  const config = TUI_AGENT_CONFIG[args.agent]
  const resolvedAgentCommand = args.agentCommand?.trim()
  const baseCommand = resolvedAgentCommand
    ? ({ ok: true, command: resolvedAgentCommand } as const)
    : resolveBaseCommand({
        agent: args.agent,
        cmdOverrides: args.cmdOverrides,
        platform: args.platform,
        shell,
        agentArgs: args.agentArgs
      })
  if (!baseCommand.ok) {
    return null
  }
  const launchConfig = buildSleepingAgentLaunchConfig({
    ...args,
    agentCommand: baseCommand.command
  })
  const resumeArgs = argv
    .slice(1)
    .map((arg) => quoteStartupArg(arg, shell))
    .join(' ')
  const launchCommand = resumeArgs ? `${baseCommand.command} ${resumeArgs}` : baseCommand.command
  return {
    agent: args.agent,
    launchCommand,
    expectedProcess: config.expectedProcess,
    followupPrompt: null,
    launchConfig,
    ...(args.agentEnv ? { env: { ...args.agentEnv } } : {})
  }
}

export type AgentDraftLaunchPlan = {
  agent: TuiAgent
  launchCommand: string
  expectedProcess: string
  launchConfig: SleepingAgentLaunchConfig
  env?: Record<string, string>
  startupCommandDelivery?: StartupCommandDelivery
}

function inlineDraftPlanFitsPlatform(
  plan: AgentDraftLaunchPlan,
  platform: NodeJS.Platform
): boolean {
  if (platform !== 'win32') {
    return true
  }
  const envChars = Object.entries(plan.env ?? {}).reduce(
    (total, [key, value]) => total + key.length + value.length,
    0
  )
  // Why: Windows CreateProcess/env blocks have tight length ceilings. Large
  // generated drafts should use the existing post-ready paste fallback.
  return plan.launchCommand.length + envChars <= WIN32_INLINE_DRAFT_LIMIT_CHARS
}

export function buildAgentDraftLaunchPlan(args: {
  agent: TuiAgent
  draft: string
  cmdOverrides: Partial<Record<TuiAgent, string>>
  platform: NodeJS.Platform
  shell?: AgentStartupShell
  agentArgs?: string | null
  agentEnv?: Record<string, string> | null
}): AgentDraftLaunchPlan | null {
  const { agent, draft, cmdOverrides, platform } = args
  const shell = resolveStartupShell(platform, args.shell)
  const config = TUI_AGENT_CONFIG[agent]
  const trimmed = draft.trim()
  if (!trimmed) {
    return null
  }
  const baseCommand = resolveBaseCommand({
    agent,
    cmdOverrides,
    platform,
    shell,
    agentArgs: args.agentArgs
  })
  if (!baseCommand.ok) {
    return null
  }
  const launchConfig = buildSleepingAgentLaunchConfig({
    ...args,
    agentCommand: baseCommand.command
  })
  let plan: AgentDraftLaunchPlan | null = null
  if (config.draftPromptFlag) {
    const quoted = quoteStartupArg(trimmed, shell)
    plan = {
      agent,
      launchCommand: `${baseCommand.command} ${config.draftPromptFlag} ${quoted}`,
      expectedProcess: config.expectedProcess,
      launchConfig,
      // Why: native draft flags carry user text on argv and must survive rc-file startup.
      ...(agent === 'codex' ? { startupCommandDelivery: 'shell-ready' as const } : {}),
      ...(args.agentEnv ? { env: { ...args.agentEnv } } : {})
    }
  } else if (config.draftPromptEnvVar) {
    const clearVar = clearEnvCommand(config.draftPromptEnvVar, shell)
    plan = {
      agent,
      launchCommand: `${baseCommand.command}${commandSeparator(shell)}${clearVar}`,
      expectedProcess: config.expectedProcess,
      launchConfig,
      env: { ...args.agentEnv, [config.draftPromptEnvVar]: trimmed }
    }
  }
  if (!plan || !inlineDraftPlanFitsPlatform(plan, platform)) {
    return null
  }
  return plan
}

export { isShellProcess }
export {
  buildShellCommandFromArgv,
  planAgentCliArgsSuffix,
  quoteStartupArg,
  resolveStartupShell
} from './tui-agent-startup-shell'
export type { AgentCliArgsPlan, AgentStartupShell } from './tui-agent-startup-shell'
