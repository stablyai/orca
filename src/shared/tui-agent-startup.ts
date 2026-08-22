import { isShellProcess } from './agent-detection'
import type { AgentStatusHookSettings } from './agent-status-hooks-for-agent'
import {
  getAgentResumeArgv,
  type AgentProviderSessionMetadata,
  type ResumableTuiAgent,
  type SleepingAgentLaunchConfig
} from './agent-session-resume'
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
import { buildAgentResumeLaunchCommand } from './agent-resume-launch-command'

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
  /** Values actually emitted into this launch command, kept as base model ids
   * so the native-chat surface can render only launch-backed state. */
  sessionOptions?: Record<string, SessionOptionValue>
}

function appliedSessionOptionProps(values: Record<string, SessionOptionValue>) {
  return Object.keys(values).length > 0 ? { sessionOptions: { ...values } } : {}
}

/** Inputs every launch plan resolves its base command from. */
type AgentLaunchPlanCommonArgs = {
  cmdOverrides: Partial<Record<TuiAgent, string>>
  platform: NodeJS.Platform
  shell?: AgentStartupShell
  agentArgs?: string | null
  agentEnv?: Record<string, string> | null
  sessionOptions?: Record<string, SessionOptionValue>
  /** Why: SSH remotes deploy the CLI shim as plain `orca`, so the Linux-only
   * `orca-ide` rename must be skipped for remote launches. */
  isRemote?: boolean
  /** Required, not optional (#11941): the old optional boolean defaulted to
   * "hooks off", inverting the shipped default for every surface that forgot it.
   * Passed as settings, not a flag, so no caller repeats the derivation. */
  agentStatusHookSettings: AgentStatusHookSettings | null
}

export function buildAgentStartupPlan(
  args: AgentLaunchPlanCommonArgs & {
    agent: TuiAgent
    prompt: string
    allowEmptyPromptLaunch?: boolean
    sessionOptionsOverrideAgentArgs?: boolean
  }
): AgentStartupPlan | null {
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
    agentStatusHookSettings: args.agentStatusHookSettings
  })
  if (!baseCommand.ok) {
    return null
  }
  const launchConfig = buildSleepingAgentLaunchConfig({
    ...args,
    // Why: picker flags are a one-time launch choice; a resumed provider
    // session restores its own state and must retain only explicit user args.
    agentCommand: baseCommand.commandWithoutSessionOptions
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
      ...appliedSessionOptionProps(baseCommand.appliedSessionOptions),
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
      ...appliedSessionOptionProps(baseCommand.appliedSessionOptions),
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
      ...appliedSessionOptionProps(baseCommand.appliedSessionOptions),
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
      ...appliedSessionOptionProps(baseCommand.appliedSessionOptions),
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
      ...appliedSessionOptionProps(baseCommand.appliedSessionOptions),
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
      ...appliedSessionOptionProps(baseCommand.appliedSessionOptions),
      ...(args.agentEnv ? { env: { ...args.agentEnv } } : {})
    }
  }

  return {
    agent,
    launchCommand: baseCommand.command,
    expectedProcess: config.expectedProcess,
    followupPrompt: trimmedPrompt,
    launchConfig,
    ...appliedSessionOptionProps(baseCommand.appliedSessionOptions),
    ...(args.agentEnv ? { env: { ...args.agentEnv } } : {})
  }
}

// Why the hooks settings matter on resume: a resumed remote Codex re-attaches to
// the same env-less app-server a fresh launch does. A stored `agentCommand`
// already carries the override, so only the rebuild path needs it.
export function buildAgentResumeStartupPlan(
  args: AgentLaunchPlanCommonArgs & {
    agent: ResumableTuiAgent
    providerSession: AgentProviderSessionMetadata
    agentCommand?: string | null
    ompResumeFilePath?: string | null
  }
): AgentStartupPlan | null {
  const argv = getAgentResumeArgv(args.agent, args.providerSession, args.ompResumeFilePath)
  if (!argv) {
    return null
  }
  const shell = resolveStartupShell(args.platform, args.shell)
  const config = TUI_AGENT_CONFIG[args.agent]
  const resolvedAgentCommand = args.agentCommand?.trim()
  const baseCommand = resolvedAgentCommand
    ? ({ ok: true, command: resolvedAgentCommand } as const)
    : resolveAgentLaunchCommand({
        agent: args.agent,
        cmdOverrides: args.cmdOverrides,
        platform: args.platform,
        shell,
        agentArgs: args.agentArgs,
        isRemote: args.isRemote,
        agentStatusHookSettings: args.agentStatusHookSettings
      })
  if (!baseCommand.ok) {
    return null
  }
  const launchConfig = buildSleepingAgentLaunchConfig({
    ...args,
    agentCommand: baseCommand.command
  })
  return {
    agent: args.agent,
    launchCommand: buildAgentResumeLaunchCommand(args.agent, baseCommand.command, argv, shell),
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
  sessionOptions?: Record<string, SessionOptionValue>
}

export function buildAgentDraftLaunchPlan(
  args: AgentLaunchPlanCommonArgs & { agent: TuiAgent; draft: string }
): AgentDraftLaunchPlan | null {
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
    isRemote: args.isRemote,
    agentStatusHookSettings: args.agentStatusHookSettings
  })
  if (!baseCommand.ok) {
    return null
  }
  const launchConfig = buildSleepingAgentLaunchConfig({
    ...args,
    // Why: see the new-session path above — resume must not replay picker flags.
    agentCommand: baseCommand.commandWithoutSessionOptions
  })
  let plan: AgentDraftLaunchPlan | null = null
  if (config.draftPromptFlag) {
    const quoted = quoteStartupArg(trimmed, shell)
    plan = {
      agent,
      launchCommand: `${baseCommand.command} ${config.draftPromptFlag} ${quoted}`,
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
      launchCommand: `${baseCommand.command}${commandSeparator(shell)}${clearVar}`,
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
