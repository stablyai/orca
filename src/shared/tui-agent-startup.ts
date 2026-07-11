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
import { buildSleepingAgentLaunchConfig } from './sleeping-agent-launch-config'
import { planHermesStartupQuery } from './hermes-startup-query'
import { inlineAgentDraftFitsPlatform } from './agent-draft-platform-limit'
import type { TuiAgent } from './types'

export type AgentStartupPlan = {
  agent: TuiAgent
  launchCommand: string
  expectedProcess: string
  followupPrompt: string | null
  launchConfig: SleepingAgentLaunchConfig
  launchToken?: string
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
  isRemote?: boolean
}): { ok: true; command: string } | { ok: false; error: string } {
  const override = args.cmdOverrides[args.agent]
  const command =
    override ||
    getTuiAgentLaunchCommand(TUI_AGENT_CONFIG[args.agent], args.platform, {
      isRemote: args.isRemote
    })
  const suffix = planAgentCliArgsSuffix(args.agentArgs, args.shell)
  if (!suffix.ok) {
    return suffix
  }
  // Why: Codex status hooks live in Orca's runtime CODEX_HOME; adding
  // --profile-v2 makes Codex load a second hook representation and warn.
  return { ok: true, command: suffix.suffix ? `${command} ${suffix.suffix}` : command }
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
  /** Why: SSH remotes deploy the CLI shim as plain `orca`, so the Linux-only
   * `orca-ide` rename must be skipped for remote launches. */
  isRemote?: boolean
}): AgentStartupPlan | null {
  const { agent, prompt, cmdOverrides, platform, allowEmptyPromptLaunch = false } = args
  const shell = resolveStartupShell(platform, args.shell)
  const trimmedPrompt = prompt.trim()
  const config = TUI_AGENT_CONFIG[agent]
  const usesQuery = config.promptInjectionMode === 'hermes-query' && Boolean(trimmedPrompt)
  const baseCommand = resolveBaseCommand({
    agent,
    cmdOverrides,
    platform,
    shell,
    agentArgs: usesQuery ? null : args.agentArgs,
    isRemote: args.isRemote
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
    const promptSeparator = config.argvPromptSeparator ? ` ${config.argvPromptSeparator}` : ''
    return {
      agent,
      launchCommand: `${baseCommand.command}${promptSeparator} ${quotedPrompt}`,
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

  if (config.promptInjectionMode === 'hermes-query') {
    const queryPlan = planHermesStartupQuery({
      baseCommand: baseCommand.command,
      agentArgs: args.agentArgs,
      prompt: trimmedPrompt,
      agentEnv: args.agentEnv,
      platform,
      shell,
      isRemote: args.isRemote
    })
    if (!queryPlan) {
      return null
    }
    return {
      agent,
      // Why: Hermes owns readiness and submission for `chat --query`; Orca
      // only bounds and quotes the native invocation before starting the TUI.
      launchCommand: queryPlan.command,
      expectedProcess: config.expectedProcess,
      followupPrompt: null,
      launchConfig,
      ...(queryPlan.env ? { env: queryPlan.env } : {})
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
  /** Why: see buildAgentStartupPlan — remote launches use the plain `orca` shim. */
  isRemote?: boolean
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
        agentArgs: args.agentArgs,
        isRemote: args.isRemote
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

export function buildAgentDraftLaunchPlan(args: {
  agent: TuiAgent
  draft: string
  cmdOverrides: Partial<Record<TuiAgent, string>>
  platform: NodeJS.Platform
  shell?: AgentStartupShell
  agentArgs?: string | null
  agentEnv?: Record<string, string> | null
  /** Why: see buildAgentStartupPlan — remote launches use the plain `orca` shim. */
  isRemote?: boolean
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
    agentArgs: args.agentArgs,
    isRemote: args.isRemote
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
  if (
    !plan ||
    !inlineAgentDraftFitsPlatform({ command: plan.launchCommand, env: plan.env, platform })
  ) {
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
