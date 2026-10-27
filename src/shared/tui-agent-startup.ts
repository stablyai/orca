import { withFreshOmpLaunch, isFreshOmpLaunchCommand } from './omp-fresh-launch'
import { withOmpDraftCleanup } from './omp-draft-launch'
import { isShellProcess } from './agent-detection'
import type { SleepingAgentLaunchConfig } from './agent-session-resume'
import {
  clearEnvCommand,
  commandSeparator,
  quoteStartupArg,
  resolveStartupShell,
  type AgentStartupShell
} from './tui-agent-startup-shell'
import { TUI_AGENT_CONFIG } from './tui-agent-config'
import type { StartupCommandDelivery } from './codex-startup-delivery'
import { buildSleepingAgentLaunchConfig } from './sleeping-agent-launch-config'
import { planHermesStartupQuery } from './hermes-startup-query'
import { inlineAgentDraftFitsPlatform } from './agent-draft-platform-limit'
import type { TuiAgent } from './tui-agent'
import type { SessionOptionValue } from './native-chat-session-options'
import { resolveAgentLaunchCommand } from './tui-agent-launch-command'
import { appliedSessionOptionProps, buildFlagPromptStartupPlan } from './flag-prompt-startup'

export { buildAgentResumeStartupPlan } from './tui-agent-resume-startup'

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
  /** Carry only emitted base model IDs so native chat shows launch-backed session options. */
  sessionOptions?: Record<string, SessionOptionValue>
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
  sessionOptions?: Record<string, SessionOptionValue>
  sessionOptionsOverrideAgentArgs?: boolean
  /** Remote Linux deploys orca, so skip the local-only orca-ide rename. */
  isRemote?: boolean
  /** Orca types into this launch after start, so a startup update prompt would take that input. */
  suppressStartupUpdatePrompt?: boolean
}): AgentStartupPlan | null {
  const { agent, prompt, cmdOverrides, platform, allowEmptyPromptLaunch = false } = args
  const shell = resolveStartupShell(platform, args.shell)
  const trimmedPrompt = prompt.trim()
  const config = TUI_AGENT_CONFIG[agent]
  const usesQuery = config.promptInjectionMode === 'hermes-query' && Boolean(trimmedPrompt)
  const baseCommand = resolveAgentLaunchCommand({
    agent,
    cmdOverrides,
    platform,
    shell,
    agentArgs: usesQuery ? null : args.agentArgs,
    sessionOptions: args.sessionOptions,
    sessionOptionsOverrideAgentArgs: args.sessionOptionsOverrideAgentArgs,
    isRemote: args.isRemote,
    suppressStartupUpdatePrompt: args.suppressStartupUpdatePrompt
  })
  if (!baseCommand.ok) {
    return null
  }
  const launchCommand =
    agent === 'omp' ? withFreshOmpLaunch(baseCommand.command, shell) : baseCommand.command
  // Hermes query launches splice agentArgs themselves; record them anyway so a resume keeps them.
  const recordedCommand = usesQuery
    ? resolveAgentLaunchCommand({
        agent,
        cmdOverrides,
        platform,
        shell,
        agentArgs: args.agentArgs,
        isRemote: args.isRemote
      })
    : baseCommand
  const launchConfig = buildSleepingAgentLaunchConfig({
    ...args,
    ...(recordedCommand.ok ? recordedCommand.resumeLaunch : baseCommand.resumeLaunch)
  })

  if (!trimmedPrompt) {
    if (!allowEmptyPromptLaunch) {
      return null
    }
    return {
      agent,
      launchCommand,
      expectedProcess: config.expectedProcess,
      followupPrompt: null,
      launchConfig,
      ...appliedSessionOptionProps(baseCommand.appliedSessionOptions),
      ...(args.agentEnv ? { env: { ...args.agentEnv } } : {})
    }
  }

  const quotedPrompt = quoteStartupArg(trimmedPrompt, shell)

  if (config.promptInjectionMode === 'argv') {
    const promptSeparator = config.argvPromptSeparator ? ` ${config.argvPromptSeparator}` : ''
    return {
      agent,
      launchCommand:
        agent === 'omp'
          ? withFreshOmpLaunch(baseCommand.command, shell, `${promptSeparator} ${quotedPrompt}`)
          : `${launchCommand}${promptSeparator} ${quotedPrompt}`,
      expectedProcess: config.expectedProcess,
      followupPrompt: null,
      launchConfig,
      ...appliedSessionOptionProps(baseCommand.appliedSessionOptions),
      ...(agent === 'codex' ? { startupCommandDelivery: 'shell-ready' as const } : {}),
      ...(args.agentEnv ? { env: { ...args.agentEnv } } : {})
    }
  }

  if (config.promptInjectionMode === 'flag-prompt') {
    return buildFlagPromptStartupPlan({
      agent,
      launchCommand,
      quotedPrompt,
      prompt: trimmedPrompt,
      shell,
      launchConfig,
      sessionOptions: baseCommand.appliedSessionOptions,
      agentEnv: args.agentEnv
    })
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
      // Hermes chat --query owns readiness/submission; Orca only bounds and quotes its native invocation.
      launchCommand: queryPlan.command,
      expectedProcess: config.expectedProcess,
      followupPrompt: null,
      launchConfig,
      ...appliedSessionOptionProps(baseCommand.appliedSessionOptions),
      ...(queryPlan.env ? { env: queryPlan.env } : {})
    }
  }

  if (config.promptInjectionMode === 'flag-prompt-interactive') {
    return {
      agent,
      launchCommand: `${launchCommand} --prompt-interactive ${quotedPrompt}`,
      expectedProcess: config.expectedProcess,
      followupPrompt: null,
      launchConfig,
      ...appliedSessionOptionProps(baseCommand.appliedSessionOptions),
      ...(args.agentEnv ? { env: { ...args.agentEnv } } : {})
    }
  }

  if (config.promptInjectionMode === 'flag-interactive') {
    return {
      agent,
      launchCommand: `${launchCommand} -i ${quotedPrompt}`,
      expectedProcess: config.expectedProcess,
      followupPrompt: null,
      launchConfig,
      ...appliedSessionOptionProps(baseCommand.appliedSessionOptions),
      ...(args.agentEnv ? { env: { ...args.agentEnv } } : {})
    }
  }

  return {
    agent,
    launchCommand,
    expectedProcess: config.expectedProcess,
    followupPrompt: trimmedPrompt,
    launchConfig,
    ...appliedSessionOptionProps(baseCommand.appliedSessionOptions),
    ...(args.agentEnv ? { env: { ...args.agentEnv } } : {})
  }
}

/** Predict the builder’s null-followupPrompt verdict before choosing a launch surface; derive from the same injection table and pin every agent in tui-agent-prompt-transport.spec.ts.
 * All modes except stdin-after-start carry the prompt through the launch command; Hermes may reference an env carrier instead of literal prompt argv. */
export function agentPromptRidesLaunchCommand(agent: TuiAgent): boolean {
  return TUI_AGENT_CONFIG[agent].promptInjectionMode !== 'stdin-after-start'
}

export type AgentDraftLaunchPlan = {
  agent: TuiAgent
  launchCommand: string
  expectedProcess: string
  launchConfig: SleepingAgentLaunchConfig
  env?: Record<string, string>
  startupCommandDelivery?: StartupCommandDelivery
  sessionOptions?: Record<string, SessionOptionValue>
}

export function buildAgentDraftLaunchPlan(args: {
  agent: TuiAgent
  draft: string
  cmdOverrides: Partial<Record<TuiAgent, string>>
  platform: NodeJS.Platform
  shell?: AgentStartupShell
  agentArgs?: string | null
  agentEnv?: Record<string, string> | null
  sessionOptions?: Record<string, SessionOptionValue>
  sessionOptionsOverrideAgentArgs?: boolean
  isRemote?: boolean
}): AgentDraftLaunchPlan | null {
  const { agent, draft, cmdOverrides, platform } = args
  const shell = resolveStartupShell(platform, args.shell)
  const config = TUI_AGENT_CONFIG[agent]
  const trimmed = draft.trim()
  if (!trimmed) {
    return null
  }
  const baseCommand = resolveAgentLaunchCommand({
    agent,
    cmdOverrides,
    platform,
    shell,
    agentArgs: args.agentArgs,
    sessionOptions: args.sessionOptions,
    sessionOptionsOverrideAgentArgs: args.sessionOptionsOverrideAgentArgs,
    isRemote: args.isRemote
  })
  if (!baseCommand.ok) {
    return null
  }
  const launchCommand =
    agent === 'omp' ? withFreshOmpLaunch(baseCommand.command, shell) : baseCommand.command
  const launchConfig = buildSleepingAgentLaunchConfig({
    ...args,
    ...baseCommand.resumeLaunch
  })
  let plan: AgentDraftLaunchPlan | null = null
  if (config.draftPromptFlag && shell === 'cmd' && /[\r\n]/.test(trimmed)) {
    // Why: cmd.exe cannot quote a newline, so each one would submit the line early; paste instead.
    return null
  }
  if (config.draftPromptFlag) {
    const quoted = quoteStartupArg(trimmed, shell)
    plan = {
      agent,
      launchCommand: `${launchCommand} ${config.draftPromptFlag} ${quoted}`,
      expectedProcess: config.expectedProcess,
      launchConfig,
      ...appliedSessionOptionProps(baseCommand.appliedSessionOptions),
      // Why: native draft flags carry user text on argv and must survive rc-file startup.
      ...(agent === 'codex' ? { startupCommandDelivery: 'shell-ready' as const } : {}),
      ...(args.agentEnv ? { env: { ...args.agentEnv } } : {})
    }
  } else if (config.draftPromptEnvVar) {
    const clearVar = clearEnvCommand(config.draftPromptEnvVar, shell)
    plan = {
      agent,
      launchCommand:
        agent === 'omp' && isFreshOmpLaunchCommand(launchCommand)
          ? withOmpDraftCleanup(launchCommand, shell)
          : `${launchCommand}${commandSeparator(shell)}${clearVar}`,
      expectedProcess: config.expectedProcess,
      launchConfig,
      ...appliedSessionOptionProps(baseCommand.appliedSessionOptions),
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
