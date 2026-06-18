import { isShellProcess } from './agent-detection'
import {
  getAgentResumeArgv,
  type AgentProviderSessionMetadata,
  type ResumableTuiAgent
} from './agent-session-resume'
import { tokenizeCustomCommandTemplate } from './commit-message-prompt'
import { TUI_AGENT_CONFIG } from './tui-agent-config'
import type { StartupCommandDelivery } from './codex-startup-delivery'
import type { TuiAgent } from './types'

const WIN32_INLINE_DRAFT_LIMIT_CHARS = 24_000

export type AgentStartupPlan = {
  agent: TuiAgent
  launchCommand: string
  expectedProcess: string
  followupPrompt: string | null
  draftPrompt?: string | null
  env?: Record<string, string>
  startupCommandDelivery?: StartupCommandDelivery
}

export type AgentStartupShell = 'posix' | 'powershell' | 'cmd'

export function resolveStartupShell(
  platform: NodeJS.Platform,
  shell?: AgentStartupShell
): AgentStartupShell {
  return shell ?? (platform === 'win32' ? 'powershell' : 'posix')
}

export function quoteStartupArg(value: string, shell: AgentStartupShell): string {
  if (shell === 'powershell') {
    return `'${value.replace(/'/g, "''")}'`
  }
  if (shell === 'cmd') {
    return `"${value.replace(/([\^&|<>()%!"])/g, '^$1')}"`
  }
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export function buildShellCommandFromArgv(
  args: readonly string[],
  shell: AgentStartupShell
): string {
  const command = args.map((arg) => quoteStartupArg(arg, shell)).join(' ')
  if (shell === 'powershell' && command) {
    return `& ${command}`
  }
  return command
}

function clearEnvCommand(name: string, shell: AgentStartupShell): string {
  if (shell === 'powershell') {
    return `Remove-Item Env:${name} -ErrorAction SilentlyContinue`
  }
  if (shell === 'cmd') {
    return `set "${name}="`
  }
  return `unset ${name}`
}

function commandSeparator(shell: AgentStartupShell): string {
  return shell === 'cmd' ? ' & ' : '; '
}

export type AgentCliArgsPlan = { ok: true; suffix: string } | { ok: false; error: string }

export function planAgentCliArgsSuffix(
  agentArgs: string | null | undefined,
  shell: AgentStartupShell
): AgentCliArgsPlan {
  const trimmed = agentArgs?.trim()
  if (!trimmed) {
    return { ok: true, suffix: '' }
  }
  const tokenized = tokenizeCustomCommandTemplate(trimmed)
  if (!tokenized.ok) {
    return { ok: false, error: `CLI arguments are invalid: ${tokenized.error}` }
  }
  return {
    ok: true,
    suffix: tokenized.tokens.map((token) => quoteStartupArg(token, shell)).join(' ')
  }
}

function resolveBaseCommand(args: {
  agent: TuiAgent
  cmdOverrides: Partial<Record<TuiAgent, string>>
  shell: AgentStartupShell
  agentArgs?: string | null
}): { ok: true; command: string } | { ok: false; error: string } {
  const override = args.cmdOverrides[args.agent]
  const command = override || TUI_AGENT_CONFIG[args.agent].launchCmd
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
}): AgentStartupPlan | null {
  const { agent, prompt, cmdOverrides, platform, allowEmptyPromptLaunch = false } = args
  const shell = resolveStartupShell(platform, args.shell)
  const trimmedPrompt = prompt.trim()
  const config = TUI_AGENT_CONFIG[agent]
  const baseCommand = resolveBaseCommand({
    agent,
    cmdOverrides,
    shell,
    agentArgs: args.agentArgs
  })
  if (!baseCommand.ok) {
    return null
  }

  if (!trimmedPrompt) {
    if (!allowEmptyPromptLaunch) {
      return null
    }
    return {
      agent,
      launchCommand: baseCommand.command,
      expectedProcess: config.expectedProcess,
      followupPrompt: null,
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
      ...(args.agentEnv ? { env: { ...args.agentEnv } } : {})
    }
  }

  if (config.promptInjectionMode === 'flag-prompt-interactive') {
    return {
      agent,
      launchCommand: `${baseCommand.command} --prompt-interactive ${quotedPrompt}`,
      expectedProcess: config.expectedProcess,
      followupPrompt: null,
      ...(args.agentEnv ? { env: { ...args.agentEnv } } : {})
    }
  }

  if (config.promptInjectionMode === 'flag-interactive') {
    return {
      agent,
      launchCommand: `${baseCommand.command} -i ${quotedPrompt}`,
      expectedProcess: config.expectedProcess,
      followupPrompt: null,
      ...(args.agentEnv ? { env: { ...args.agentEnv } } : {})
    }
  }

  return {
    agent,
    launchCommand: baseCommand.command,
    expectedProcess: config.expectedProcess,
    followupPrompt: trimmedPrompt,
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
}): AgentStartupPlan | null {
  const argv = getAgentResumeArgv(args.agent, args.providerSession)
  if (!argv) {
    return null
  }
  const shell = resolveStartupShell(args.platform, args.shell)
  const config = TUI_AGENT_CONFIG[args.agent]
  const baseCommand = resolveBaseCommand({
    agent: args.agent,
    cmdOverrides: args.cmdOverrides,
    shell,
    agentArgs: args.agentArgs
  })
  if (!baseCommand.ok) {
    return null
  }
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
    ...(args.agentEnv ? { env: { ...args.agentEnv } } : {})
  }
}

export type AgentDraftLaunchPlan = {
  agent: TuiAgent
  launchCommand: string
  expectedProcess: string
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
    shell,
    agentArgs: args.agentArgs
  })
  if (!baseCommand.ok) {
    return null
  }
  let plan: AgentDraftLaunchPlan | null = null
  if (config.draftPromptFlag) {
    const quoted = quoteStartupArg(trimmed, shell)
    plan = {
      agent,
      launchCommand: `${baseCommand.command} ${config.draftPromptFlag} ${quoted}`,
      expectedProcess: config.expectedProcess,
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
      env: { ...args.agentEnv, [config.draftPromptEnvVar]: trimmed }
    }
  }
  if (!plan || !inlineDraftPlanFitsPlatform(plan, platform)) {
    return null
  }
  return plan
}

export { isShellProcess }
