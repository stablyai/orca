import { isShellProcess } from './agent-detection'
import {
  getAgentResumeArgv,
  type AgentProviderSessionMetadata,
  type ResumableTuiAgent,
  type SleepingAgentLaunchConfig
} from './agent-session-resume'
import {
  appendSessionRulesFileCleanup,
  appendSessionRulesFlag,
  hasNativeSessionRulesInjection,
  prependSessionRulesToPrompt,
  quoteStartupArg,
  resolveSessionRulesDeliveryShell,
  resolveStartupShell,
  sessionRulesTextRequiresPostReadyDelivery,
  type AgentStartupShell
} from './tui-agent-startup-shell'
import { TUI_AGENT_CONFIG } from './tui-agent-config'
import type { StartupCommandDelivery } from './codex-startup-delivery'
import { buildSleepingAgentLaunchConfig } from './sleeping-agent-launch-config'
import { planHermesStartupQuery } from './hermes-startup-query'
import type { TuiAgent } from './types'
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
  /** Why: SSH remotes deploy the CLI shim as plain `orca`, so the Linux-only
   * `orca-ide` rename must be skipped for remote launches. */
  isRemote?: boolean
  /** Path to a file of global session rules text, injected via config.sessionRulesFileFlag. */
  agentSessionRulesFilePath?: string | null
  /** Inline global session rules for the prompt-prepend fallback. */
  agentSessionRulesText?: string | null
}): AgentStartupPlan | null {
  const { agent, prompt, cmdOverrides, platform, allowEmptyPromptLaunch = false } = args
  const shell = resolveStartupShell(platform, args.shell)
  const rulesDeliveryShell = resolveSessionRulesDeliveryShell(args)
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
    isRemote: args.isRemote
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
  if (!trimmedPrompt && !allowEmptyPromptLaunch) {
    return null
  }
  // Why: cmd.exe can't reliably carry rules text inline via any path — native flag or prepended
  // prompt alike — so this overrides the agent's own promptInjectionMode entirely and defers
  // everything (rules + whatever prompt there is) to a paste-and-submit follow-up instead.
  if (sessionRulesTextRequiresPostReadyDelivery(args.agentSessionRulesText, rulesDeliveryShell)) {
    return {
      agent,
      launchCommand: baseCommand.command,
      expectedProcess: config.expectedProcess,
      followupPrompt: args.agentSessionRulesText?.trim()
        ? prependSessionRulesToPrompt(trimmedPrompt, args.agentSessionRulesText)
        : trimmedPrompt || null,
      launchConfig,
      ...appliedSessionOptionProps(baseCommand.appliedSessionOptions),
      ...(args.agentEnv ? { env: { ...args.agentEnv } } : {})
    }
  }
  const hasNativeRulesInjection = hasNativeSessionRulesInjection(
    config,
    args.agentSessionRulesFilePath,
    args.agentSessionRulesText,
    rulesDeliveryShell
  )
  const commandWithSessionRules = appendSessionRulesFlag(
    baseCommand.command,
    config,
    args.agentSessionRulesFilePath,
    hasNativeRulesInjection ? args.agentSessionRulesText : null,
    rulesDeliveryShell
  )
  const withSessionRulesCleanup = (launchCommand: string): string =>
    appendSessionRulesFileCleanup(
      launchCommand,
      hasNativeRulesInjection ? args.agentSessionRulesFilePath : null,
      shell
    )

  if (!trimmedPrompt) {
    return {
      agent,
      launchCommand: withSessionRulesCleanup(commandWithSessionRules),
      expectedProcess: config.expectedProcess,
      followupPrompt: null,
      launchConfig,
      ...appliedSessionOptionProps(baseCommand.appliedSessionOptions),
      ...(args.agentEnv ? { env: { ...args.agentEnv } } : {})
    }
  }

  const effectivePrompt =
    args.agentSessionRulesText?.trim() && !hasNativeRulesInjection
      ? prependSessionRulesToPrompt(trimmedPrompt, args.agentSessionRulesText)
      : trimmedPrompt
  const quotedPrompt = quoteStartupArg(effectivePrompt, shell)

  if (config.promptInjectionMode === 'argv') {
    const promptSeparator = config.argvPromptSeparator ? ` ${config.argvPromptSeparator}` : ''
    return {
      agent,
      launchCommand: withSessionRulesCleanup(
        `${commandWithSessionRules}${promptSeparator} ${quotedPrompt}`
      ),
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
      launchCommand: withSessionRulesCleanup(`${commandWithSessionRules} --prompt ${quotedPrompt}`),
      expectedProcess: config.expectedProcess,
      followupPrompt: null,
      launchConfig,
      ...appliedSessionOptionProps(baseCommand.appliedSessionOptions),
      ...(args.agentEnv ? { env: { ...args.agentEnv } } : {})
    }
  }

  if (config.promptInjectionMode === 'hermes-query') {
    const queryPlan = planHermesStartupQuery({
      baseCommand: commandWithSessionRules,
      agentArgs: args.agentArgs,
      prompt: effectivePrompt,
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
      launchCommand: withSessionRulesCleanup(queryPlan.command),
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
      launchCommand: withSessionRulesCleanup(
        `${commandWithSessionRules} --prompt-interactive ${quotedPrompt}`
      ),
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
      launchCommand: withSessionRulesCleanup(`${commandWithSessionRules} -i ${quotedPrompt}`),
      expectedProcess: config.expectedProcess,
      followupPrompt: null,
      launchConfig,
      ...appliedSessionOptionProps(baseCommand.appliedSessionOptions),
      ...(args.agentEnv ? { env: { ...args.agentEnv } } : {})
    }
  }

  return {
    agent,
    launchCommand: withSessionRulesCleanup(commandWithSessionRules),
    expectedProcess: config.expectedProcess,
    followupPrompt: effectivePrompt,
    launchConfig,
    ...appliedSessionOptionProps(baseCommand.appliedSessionOptions),
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
  ompResumeFilePath?: string | null
  sessionOptions?: Record<string, SessionOptionValue>
  /** Why: see buildAgentStartupPlan — remote launches use the plain `orca` shim. */
  isRemote?: boolean
  /** Why: accepted for a uniform call shape with buildAgentStartupPlan/buildAgentDraftLaunchPlan —
   * resume has no initial prompt to inject into, so the renderer wrapper applies session rules to
   * the returned plan's draftPrompt itself instead (see tui-agent-startup.ts's own resume wrapper). */
  agentSessionRulesFilePath?: string | null
  agentSessionRulesText?: string | null
}): AgentStartupPlan | null {
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
        isRemote: args.isRemote
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

export { isShellProcess }
export {
  buildShellCommandFromArgv,
  planAgentCliArgsSuffix,
  quoteStartupArg,
  resolveSessionRulesDeliveryShell,
  resolveStartupShell
} from './tui-agent-startup-shell'
// Why: split out to keep this file under the repo's max-lines cap; also the only file
// with a real session-rules-aware buildAgentDraftLaunchPlan (this file's own copy was
// a stale duplicate missing the Windows-remote cleanup guard — see git history).
export type { AgentDraftLaunchPlan } from './tui-agent-draft-launch'
export { buildAgentDraftLaunchPlan } from './tui-agent-draft-launch'
export type { AgentCliArgsPlan, AgentStartupShell } from './tui-agent-startup-shell'
