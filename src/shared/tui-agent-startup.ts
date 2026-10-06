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
import type { LaunchFile } from './launch-prompt-file'
import type { LaunchHost } from './launch-host'
import {
  carryLaunchPrompt,
  launchFileDirectoryGrant,
  type LaunchPromptPaste,
  type LaunchPromptPlan
} from './launch-prompt-carry'
import { windowsLaunchLineVerdict } from './windows-launch-line'
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
  launchConfig: SleepingAgentLaunchConfig
  launchToken?: string
  draftPrompt?: string | null
  env?: Record<string, string>
  startupCommandDelivery?: StartupCommandDelivery
  /** Values actually emitted into this launch command, kept as base model ids
   * so the native-chat surface can render only launch-backed state. */
  sessionOptions?: Record<string, SessionOptionValue>
}

export type AgentStartupPlanInputs = {
  agent: TuiAgent
  cmdOverrides: Partial<Record<TuiAgent, string>>
  platform: NodeJS.Platform
  shell?: AgentStartupShell
  agentArgs?: string | null
  agentEnv?: Record<string, string> | null
  sessionOptions?: Record<string, SessionOptionValue>
  sessionOptionsOverrideAgentArgs?: boolean
  /** Why: SSH remotes deploy the CLI shim as plain `orca`, so the Linux-only
   * `orca-ide` rename must be skipped for remote launches. */
  isRemote?: boolean
}

/** An agent launch with no prompt; a launch that offers one is planned by `planLaunchPrompt`. */
export function buildAgentStartupPlan(
  args: AgentStartupPlanInputs & { prompt?: ''; allowEmptyPromptLaunch?: boolean }
): AgentStartupPlan | null {
  return args.allowEmptyPromptLaunch === true
    ? buildPlanWithPromptOnLine({ ...args, prompt: '' })
    : null
}

export type AgentLaunchPromptArgs = AgentStartupPlanInputs & {
  prompt: string
  /** The file `prompt` already points at, when the caller wrote its own. */
  launchFile?: LaunchFile
  /** See `CarriedPlanArgs`. */
  host: LaunchHost
  /** See `CarriedPlanArgs`. */
  paste: LaunchPromptPaste
}

/**
 * A launch that offers a prompt: where it rides (`carryLaunchPrompt`) and the plan to launch. Every
 * launch path plans its prompt here, and must switch on the outcome to reach the plan.
 */
export function planLaunchPrompt(
  args: AgentLaunchPromptArgs
): LaunchPromptPlan<AgentStartupPlan> | null {
  return carryLaunchPrompt(args, buildPlanWithPromptOnLine)
}

/** Builds the line with `prompt` on it; the carry rule decides whether it should. */
function buildPlanWithPromptOnLine(
  args: AgentStartupPlanInputs & { prompt: string; launchFile?: LaunchFile }
): AgentStartupPlan | null {
  const { agent, prompt, cmdOverrides, platform } = args
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
    isRemote: args.isRemote
  })
  if (!baseCommand.ok) {
    return null
  }
  const launchCommand =
    agent === 'omp' ? withFreshOmpLaunch(baseCommand.command, shell) : baseCommand.command
  const launchConfig = buildSleepingAgentLaunchConfig({
    ...args,
    // Why: picker flags are a one-time launch choice; a resumed provider
    // session restores its own state and must retain only explicit user args.
    agentCommand: baseCommand.commandWithoutSessionOptions
  })

  if (!trimmedPrompt) {
    return {
      agent,
      launchCommand,
      expectedProcess: config.expectedProcess,
      launchConfig,
      ...appliedSessionOptionProps(baseCommand.appliedSessionOptions),
      ...(args.agentEnv ? { env: { ...args.agentEnv } } : {})
    }
  }

  const quotedPrompt = quoteStartupArg(trimmedPrompt, shell)
  const grant = launchFileDirectoryGrant(agent, args.launchFile, shell)

  if (config.promptInjectionMode === 'argv') {
    const promptSeparator = config.argvPromptSeparator ? ` ${config.argvPromptSeparator}` : ''
    return {
      agent,
      launchCommand:
        agent === 'omp'
          ? withFreshOmpLaunch(
              baseCommand.command,
              shell,
              `${grant}${promptSeparator} ${quotedPrompt}`
            )
          : `${launchCommand}${grant}${promptSeparator} ${quotedPrompt}`,
      expectedProcess: config.expectedProcess,
      launchConfig,
      ...appliedSessionOptionProps(baseCommand.appliedSessionOptions),
      ...(agent === 'codex' ? { startupCommandDelivery: 'shell-ready' as const } : {}),
      ...(args.agentEnv ? { env: { ...args.agentEnv } } : {})
    }
  }

  if (config.promptInjectionMode === 'flag-prompt') {
    return buildFlagPromptStartupPlan({
      agent,
      launchCommand: `${launchCommand}${grant}`,
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
      // Why: Hermes owns readiness and submission for `chat --query`; Orca
      // only bounds and quotes the native invocation before starting the TUI.
      launchCommand: queryPlan.command,
      expectedProcess: config.expectedProcess,
      launchConfig,
      ...appliedSessionOptionProps(baseCommand.appliedSessionOptions),
      ...(queryPlan.env ? { env: queryPlan.env } : {})
    }
  }

  if (config.promptInjectionMode === 'flag-prompt-interactive') {
    return {
      agent,
      launchCommand: `${launchCommand}${grant} --prompt-interactive ${quotedPrompt}`,
      expectedProcess: config.expectedProcess,
      launchConfig,
      ...appliedSessionOptionProps(baseCommand.appliedSessionOptions),
      ...(args.agentEnv ? { env: { ...args.agentEnv } } : {})
    }
  }

  if (config.promptInjectionMode === 'flag-interactive') {
    return {
      agent,
      launchCommand: `${launchCommand}${grant} -i ${quotedPrompt}`,
      expectedProcess: config.expectedProcess,
      launchConfig,
      ...appliedSessionOptionProps(baseCommand.appliedSessionOptions),
      ...(args.agentEnv ? { env: { ...args.agentEnv } } : {})
    }
  }

  // `stdin-after-start`: no line carries its prompt; `carryLaunchPrompt` pastes it instead.
  return null
}

/**
 * Whether this agent's prompt rides the launch command rather than the live PTY.
 *
 * Whether the agent's CLI can take its prompt on argv at all, asked before a command exists: a
 * caller deciding how to deliver a prompt has to know which half it may get while it is still
 * choosing what to create. Derived from the one injection table rather than restating it, and pinned
 * against the builder for every agent by `tui-agent-prompt-transport.test.ts`. `planLaunchPrompt`
 * can still leave such a prompt for the paste (a file the agent is not known to read, a host that
 * cannot write its staging folder, a caller whose paste main used on a Windows host); a `false`
 * here is always the paste.
 *
 * Every mode but `stdin-after-start` folds the prompt into argv — that is what argv is FOR, so
 * multi-line and special-character text reaches the CLI as one argument instead of keystrokes.
 */
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
    // Why: see the new-session path above — resume must not replay picker flags.
    agentCommand: baseCommand.commandWithoutSessionOptions
  })
  let plan: AgentDraftLaunchPlan | null = null
  if (config.draftPromptFlag) {
    const draftLine = `${launchCommand} ${config.draftPromptFlag} ${quoteStartupArg(trimmed, shell)}`
    // Why: a line the Windows shell was measured to damage is no draft to edit, and a pointer
    // sentence is none either, so callers paste it into the agent; an unmeasured line is typed as
    // main typed it. The pane's PowerShell is not known here.
    if (
      platform === 'win32' &&
      windowsLaunchLineVerdict(trimmed, draftLine, shell, null) === 'damaged'
    ) {
      return null
    }
    plan = {
      agent,
      launchCommand: draftLine,
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
