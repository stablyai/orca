import {
  appendSessionRulesFlag,
  appendSessionRulesFileCleanup,
  appliedSessionOptionProps,
  clearEnvCommand,
  commandSeparator,
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
import type { SleepingAgentLaunchConfig } from './agent-session-resume'
import { inlineAgentDraftFitsPlatform } from './agent-draft-platform-limit'
import type { TuiAgent } from './types'
import type { SessionOptionValue } from './native-chat-session-options'
import { resolveAgentLaunchCommand } from './tui-agent-launch-command'

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
  /** Why: see buildAgentStartupPlan — remote launches use the plain `orca` shim. */
  isRemote?: boolean
  /** Path to a file of global session rules text, injected via config.sessionRulesFileFlag. */
  agentSessionRulesFilePath?: string | null
  /** Inline global session rules for native per-session injection. */
  agentSessionRulesText?: string | null
}): AgentDraftLaunchPlan | null {
  const { agent, draft, cmdOverrides, platform } = args
  const shell = resolveStartupShell(platform, args.shell)
  const rulesDeliveryShell = resolveSessionRulesDeliveryShell(args)
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
    isRemote: args.isRemote
  })
  if (!baseCommand.ok) {
    return null
  }
  const hasNativeRulesInjection = hasNativeSessionRulesInjection(
    config,
    args.agentSessionRulesFilePath,
    args.agentSessionRulesText,
    rulesDeliveryShell
  )
  if (
    !hasNativeRulesInjection &&
    sessionRulesTextRequiresPostReadyDelivery(args.agentSessionRulesText, rulesDeliveryShell)
  ) {
    return null
  }
  const effectiveDraft =
    args.agentSessionRulesText?.trim() && !hasNativeRulesInjection
      ? prependSessionRulesToPrompt(trimmed, args.agentSessionRulesText)
      : trimmed
  const commandWithSessionRules = appendSessionRulesFlag(
    baseCommand.command,
    config,
    args.agentSessionRulesFilePath,
    hasNativeRulesInjection ? args.agentSessionRulesText : null,
    rulesDeliveryShell
  )
  const launchConfig = buildSleepingAgentLaunchConfig({
    ...args,
    // Why: see the new-session path above — resume must not replay picker flags.
    agentCommand: baseCommand.commandWithoutSessionOptions
  })
  let plan: AgentDraftLaunchPlan | null = null
  if (config.draftPromptFlag) {
    const quoted = quoteStartupArg(effectiveDraft, shell)
    plan = {
      agent,
      launchCommand: `${commandWithSessionRules} ${config.draftPromptFlag} ${quoted}`,
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
      launchCommand: `${commandWithSessionRules}${commandSeparator(shell)}${clearVar}`,
      expectedProcess: config.expectedProcess,
      launchConfig,
      ...appliedSessionOptionProps(baseCommand.appliedSessionOptions),
      env: { ...args.agentEnv, [config.draftPromptEnvVar]: effectiveDraft }
    }
  }
  if (
    !plan ||
    !inlineAgentDraftFitsPlatform({ command: plan.launchCommand, env: plan.env, platform })
  ) {
    return null
  }
  return {
    ...plan,
    launchCommand: appendSessionRulesFileCleanup(
      plan.launchCommand,
      config.sessionRulesFileFlag && !(platform === 'win32' && args.isRemote && !args.shell)
        ? args.agentSessionRulesFilePath
        : null,
      shell
    )
  }
}
