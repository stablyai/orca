import { isShellProcess } from './agent-detection'
import type { SleepingAgentLaunchConfig } from './agent-session-resume'
import {
  clearEnvCommand,
  commandSeparator,
  planAgentCliArgsSuffix,
  quoteStartupArg,
  resolveStartupShell,
  type AgentStartupShell
} from './tui-agent-startup-shell'
import { getTuiAgentLaunchCommand, TUI_AGENT_CONFIG, type TuiAgentConfig } from './tui-agent-config'
import type { StartupCommandDelivery } from './codex-startup-delivery'
import { buildSleepingAgentLaunchConfig } from './sleeping-agent-launch-config'
import { planHermesStartupQuery } from './hermes-startup-query'
import { inlineAgentDraftFitsPlatform } from './agent-draft-platform-limit'
import type { TuiAgent } from './types'
import type { AgentId, CustomAgentDefinition } from './custom-agent'
import { customAgentForId, isCustomAgentId } from './custom-agent'
import { getCommandTokenPathBasename, getFirstCommandToken } from './command-token-scanner'
export { buildAgentResumeStartupPlan } from './tui-agent-resume-startup'
export type AgentStartupPlan = {
  agent: AgentId
  launchCommand: string
  expectedProcess: string
  followupPrompt: string | null
  launchConfig: SleepingAgentLaunchConfig
  launchToken?: string
  draftPrompt?: string | null
  env?: Record<string, string>
  startupCommandDelivery?: StartupCommandDelivery
}
export function resolveBaseCommand(args: {
  agent: AgentId
  cmdOverrides: Partial<Record<string, string>>
  platform: NodeJS.Platform
  shell: AgentStartupShell
  agentArgs?: string | null
  isRemote?: boolean
  customAgent?: CustomAgentDefinition
  customAgents?: readonly CustomAgentDefinition[]
}): { ok: true; command: string } | { ok: false; error: string } {
  const override = args.cmdOverrides[args.agent]
  let command: string
  if (override) {
    command = override
  } else if (isCustomAgentId(args.agent)) {
    // Why: a custom id can be orphaned (deleted/disabled/not-yet-hydrated) —
    // fall through to an error instead of indexing TUI_AGENT_CONFIG with it.
    const customAgent = args.customAgent ?? customAgentForId(args.agent, args.customAgents)
    if (!customAgent) {
      return { ok: false, error: `Unknown custom agent: ${args.agent}` }
    }
    command = customAgent.command
  } else {
    command = getTuiAgentLaunchCommand(TUI_AGENT_CONFIG[args.agent], args.platform, {
      isRemote: args.isRemote
    })
  }
  const suffix = planAgentCliArgsSuffix(args.agentArgs, args.shell)
  if (!suffix.ok) {
    return suffix
  }
  // Why: Codex status hooks live in Orca's runtime CODEX_HOME; adding
  // --profile-v2 makes Codex load a second hook representation and warn.
  return { ok: true, command: suffix.suffix ? `${command} ${suffix.suffix}` : command }
}
// Why: readiness waits (`isExpectedAgentProcess`) match against the real
// foreground process name — the literal `custom:*` id never matches it, so
// derive expectedProcess from the custom agent's own command binary instead.
function buildCustomAgentTuiConfig(
  agent: AgentId,
  customAgent: CustomAgentDefinition | undefined
): TuiAgentConfig {
  const commandToken = customAgent?.command ? getFirstCommandToken(customAgent.command) : ''
  return {
    detectCmd: '',
    launchCmd: '',
    expectedProcess: commandToken ? getCommandTokenPathBasename(commandToken) : agent,
    promptInjectionMode: customAgent?.promptMode === 'argv' ? 'argv' : 'stdin-after-start'
  }
}

export function buildAgentStartupPlan(args: {
  agent: AgentId
  prompt: string
  cmdOverrides: Partial<Record<string, string>>
  platform: NodeJS.Platform
  shell?: AgentStartupShell
  allowEmptyPromptLaunch?: boolean
  agentArgs?: string | null
  agentEnv?: Record<string, string> | null
  /** Why: SSH remotes deploy the CLI shim as plain `orca`, so the Linux-only
   * `orca-ide` rename must be skipped for remote launches. */
  isRemote?: boolean
  customAgent?: CustomAgentDefinition
  customAgents?: readonly CustomAgentDefinition[]
}): AgentStartupPlan | null {
  const { agent, prompt, cmdOverrides, platform, allowEmptyPromptLaunch = false } = args
  const shell = resolveStartupShell(platform, args.shell)
  const trimmedPrompt = prompt.trim()
  const customAgent = args.customAgent ?? customAgentForId(agent, args.customAgents)
  const config: TuiAgentConfig = isCustomAgentId(agent)
    ? buildCustomAgentTuiConfig(agent, customAgent)
    : TUI_AGENT_CONFIG[agent]
  const usesQuery = config.promptInjectionMode === 'hermes-query' && Boolean(trimmedPrompt)
  const baseCommand = resolveBaseCommand({
    agent,
    cmdOverrides,
    platform,
    shell,
    agentArgs: usesQuery ? null : args.agentArgs,
    isRemote: args.isRemote,
    customAgent,
    customAgents: args.customAgents
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

  if (isCustomAgentId(agent) && customAgent?.promptMode === 'template') {
    const template = customAgent.promptTemplate
    if (!template || !template.includes('{prompt}')) {
      return null
    }
    return {
      agent,
      launchCommand: template.replaceAll('{prompt}', quotedPrompt),
      expectedProcess: config.expectedProcess,
      followupPrompt: null,
      launchConfig,
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

export type AgentDraftLaunchPlan = {
  agent: AgentId
  launchCommand: string
  expectedProcess: string
  launchConfig: SleepingAgentLaunchConfig
  env?: Record<string, string>
  startupCommandDelivery?: StartupCommandDelivery
}

export function buildAgentDraftLaunchPlan(args: {
  agent: AgentId
  draft: string
  cmdOverrides: Partial<Record<TuiAgent, string>>
  platform: NodeJS.Platform
  shell?: AgentStartupShell
  agentArgs?: string | null
  agentEnv?: Record<string, string> | null
  /** Why: see buildAgentStartupPlan — remote launches use the plain `orca` shim. */
  isRemote?: boolean
  customAgent?: CustomAgentDefinition
  customAgents?: readonly CustomAgentDefinition[]
}): AgentDraftLaunchPlan | null {
  const { agent, draft, cmdOverrides, platform } = args
  const shell = resolveStartupShell(platform, args.shell)
  const customAgent = args.customAgent ?? customAgentForId(agent, args.customAgents)
  const config: TuiAgentConfig = isCustomAgentId(agent)
    ? buildCustomAgentTuiConfig(agent, customAgent)
    : TUI_AGENT_CONFIG[agent]
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
    isRemote: args.isRemote,
    customAgent,
    customAgents: args.customAgents
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
