import { isShellProcess } from './agent-detection'
import {
  getAgentResumeArgv,
  type AgentProviderSessionMetadata,
  type ResumableTuiAgent,
  type SleepingAgentLaunchConfig
} from './agent-session-resume'
import {
  planAgentCliArgsSuffix,
  quoteStartupArg,
  resolveStartupShell,
  type AgentStartupShell
} from './tui-agent-startup-shell'
import {
  appendCodexImageArgs,
  inlineCommandFitsPlatform,
  normalizeStartupImagePaths
} from './tui-agent-startup-codex-launch'
import { getTuiAgentLaunchCommand, TUI_AGENT_CONFIG } from './tui-agent-config'
import type { StartupCommandDelivery } from './codex-startup-delivery'
import type { TuiAgent } from './types'
import {
  buildAgentDraftLaunchPlan,
  type AgentDraftLaunchPlan
} from './tui-agent-draft-launch'

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
  /** Why: SSH remotes deploy the CLI shim as plain `orca`, so the Linux-only
   * `orca-ide` rename must be skipped for remote launches. */
  isRemote?: boolean
  /**
   * Optional image paths for agents that accept launch-time image flags.
   * Today only Codex wires these as repeatable `-i PATH` args.
   */
  imagePaths?: readonly string[] | null
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
    agentArgs: args.agentArgs,
    isRemote: args.isRemote
  })
  if (!baseCommand.ok) {
    return null
  }
  const codexImagePaths = agent === 'codex' ? normalizeStartupImagePaths(args.imagePaths) : []
  const launchBaseCommand =
    agent === 'codex'
      ? appendCodexImageArgs(baseCommand.command, codexImagePaths, shell)
      : baseCommand.command
  const launchConfig = buildSleepingAgentLaunchConfig({
    ...args,
    agentCommand: baseCommand.command
  })
  const env = args.agentEnv ? { ...args.agentEnv } : undefined

  if (!trimmedPrompt) {
    if (!allowEmptyPromptLaunch) {
      return null
    }
    return {
      agent,
      launchCommand: launchBaseCommand,
      expectedProcess: config.expectedProcess,
      followupPrompt: null,
      launchConfig,
      ...(env ? { env } : {})
    }
  }

  const quotedPrompt = quoteStartupArg(trimmedPrompt, shell)

  if (config.promptInjectionMode === 'argv') {
    const inlineLaunchCommand = `${launchBaseCommand} ${quotedPrompt}`
    // Why: Windows argv/env budgets reject oversized CreateProcess command lines.
    // Fall back to empty launch + post-ready paste-submit (followup) so the
    // prompt still lands without truncating argv.
    if (!inlineCommandFitsPlatform(inlineLaunchCommand, env, platform)) {
      return {
        agent,
        launchCommand: launchBaseCommand,
        expectedProcess: config.expectedProcess,
        followupPrompt: trimmedPrompt,
        launchConfig,
        ...(env ? { env } : {})
      }
    }
    return {
      agent,
      launchCommand: inlineLaunchCommand,
      expectedProcess: config.expectedProcess,
      followupPrompt: null,
      launchConfig,
      ...(agent === 'codex' ? { startupCommandDelivery: 'shell-ready' as const } : {}),
      ...(env ? { env } : {})
    }
  }

  if (config.promptInjectionMode === 'flag-prompt') {
    return {
      agent,
      launchCommand: `${launchBaseCommand} --prompt ${quotedPrompt}`,
      expectedProcess: config.expectedProcess,
      followupPrompt: null,
      launchConfig,
      ...(env ? { env } : {})
    }
  }

  if (config.promptInjectionMode === 'flag-prompt-interactive') {
    return {
      agent,
      launchCommand: `${launchBaseCommand} --prompt-interactive ${quotedPrompt}`,
      expectedProcess: config.expectedProcess,
      followupPrompt: null,
      launchConfig,
      ...(env ? { env } : {})
    }
  }

  if (config.promptInjectionMode === 'flag-interactive') {
    return {
      agent,
      launchCommand: `${launchBaseCommand} -i ${quotedPrompt}`,
      expectedProcess: config.expectedProcess,
      followupPrompt: null,
      launchConfig,
      ...(env ? { env } : {})
    }
  }

  return {
    agent,
    launchCommand: launchBaseCommand,
    expectedProcess: config.expectedProcess,
    followupPrompt: trimmedPrompt,
    launchConfig,
    ...(env ? { env } : {})
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

export type { AgentDraftLaunchPlan }
export { buildAgentDraftLaunchPlan }

export { isShellProcess }
export {
  buildShellCommandFromArgv,
  planAgentCliArgsSuffix,
  quoteStartupArg,
  resolveStartupShell
} from './tui-agent-startup-shell'
export type { AgentCliArgsPlan, AgentStartupShell } from './tui-agent-startup-shell'
