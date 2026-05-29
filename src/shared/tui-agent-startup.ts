import { isShellProcess } from './agent-detection'
import { getEffectiveTuiAgent, type EffectiveTuiAgent } from './effective-tui-agent'
import type { CustomTuiAgent, TuiAgentId } from './types'

export type AgentStartupPlan = {
  agent: TuiAgentId
  launchCommand: string
  expectedProcess: string
  followupPrompt: string | null
  draftPrompt?: string | null
  env?: Record<string, string>
}

export type AgentStartupShell = 'posix' | 'powershell' | 'cmd'

function resolveStartupShell(
  platform: NodeJS.Platform,
  shell?: AgentStartupShell
): AgentStartupShell {
  return shell ?? (platform === 'win32' ? 'powershell' : 'posix')
}

function quoteStartupArg(value: string, shell: AgentStartupShell): string {
  if (shell === 'powershell') {
    return `'${value.replace(/'/g, "''")}'`
  }
  if (shell === 'cmd') {
    return `"${value.replace(/([\^&|<>()%!"])/g, '^$1')}"`
  }
  return `'${value.replace(/'/g, `'\\''`)}'`
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

function resolveBaseCommand(args: {
  agent: TuiAgentId
  cmdOverrides: Partial<Record<TuiAgentId, string>>
  config: EffectiveTuiAgent
}): string {
  const override = args.cmdOverrides[args.agent]
  if (override) {
    return override
  }
  const command = args.config.launchCmd
  // Why: Codex status hooks live in Orca's runtime CODEX_HOME; adding
  // --profile-v2 makes Codex load a second hook representation and warn.
  return command
}

export function buildAgentStartupPlan(args: {
  agent: TuiAgentId
  prompt: string
  cmdOverrides: Partial<Record<TuiAgentId, string>>
  customTuiAgents?: readonly CustomTuiAgent[]
  platform: NodeJS.Platform
  shell?: AgentStartupShell
  allowEmptyPromptLaunch?: boolean
}): AgentStartupPlan | null {
  const {
    agent,
    prompt,
    cmdOverrides,
    customTuiAgents = [],
    platform,
    allowEmptyPromptLaunch = false
  } = args
  const shell = resolveStartupShell(platform, args.shell)
  const trimmedPrompt = prompt.trim()
  const config = getEffectiveTuiAgent(agent, customTuiAgents)
  if (!config) {
    return null
  }
  const baseCommand = resolveBaseCommand({
    agent,
    cmdOverrides,
    config
  })

  if (!trimmedPrompt) {
    if (!allowEmptyPromptLaunch) {
      return null
    }
    return {
      agent,
      launchCommand: baseCommand,
      expectedProcess: config.expectedProcess,
      followupPrompt: null
    }
  }

  const quotedPrompt = quoteStartupArg(trimmedPrompt, shell)

  if (config.promptInjectionMode === 'argv') {
    return {
      agent,
      launchCommand: `${baseCommand} ${quotedPrompt}`,
      expectedProcess: config.expectedProcess,
      followupPrompt: null
    }
  }

  if (config.promptInjectionMode === 'flag-prompt') {
    return {
      agent,
      launchCommand: `${baseCommand} --prompt ${quotedPrompt}`,
      expectedProcess: config.expectedProcess,
      followupPrompt: null
    }
  }

  if (config.promptInjectionMode === 'flag-prompt-interactive') {
    return {
      agent,
      launchCommand: `${baseCommand} --prompt-interactive ${quotedPrompt}`,
      expectedProcess: config.expectedProcess,
      followupPrompt: null
    }
  }

  if (config.promptInjectionMode === 'flag-interactive') {
    return {
      agent,
      launchCommand: `${baseCommand} -i ${quotedPrompt}`,
      expectedProcess: config.expectedProcess,
      followupPrompt: null
    }
  }

  return {
    agent,
    launchCommand: baseCommand,
    expectedProcess: config.expectedProcess,
    followupPrompt: trimmedPrompt
  }
}

export type AgentDraftLaunchPlan = {
  agent: TuiAgentId
  launchCommand: string
  expectedProcess: string
  env?: Record<string, string>
}

export function buildAgentDraftLaunchPlan(args: {
  agent: TuiAgentId
  draft: string
  cmdOverrides: Partial<Record<TuiAgentId, string>>
  customTuiAgents?: readonly CustomTuiAgent[]
  platform: NodeJS.Platform
  shell?: AgentStartupShell
}): AgentDraftLaunchPlan | null {
  const { agent, draft, cmdOverrides, customTuiAgents = [], platform } = args
  const shell = resolveStartupShell(platform, args.shell)
  const config = getEffectiveTuiAgent(agent, customTuiAgents)
  if (!config) {
    return null
  }
  const trimmed = draft.trim()
  if (!trimmed) {
    return null
  }
  const baseCommand = resolveBaseCommand({
    agent,
    cmdOverrides,
    config
  })
  if (config.draftPromptFlag) {
    const quoted = quoteStartupArg(trimmed, shell)
    return {
      agent,
      launchCommand: `${baseCommand} ${config.draftPromptFlag} ${quoted}`,
      expectedProcess: config.expectedProcess
    }
  }
  if (config.draftPromptEnvVar) {
    const clearVar = clearEnvCommand(config.draftPromptEnvVar, shell)
    return {
      agent,
      launchCommand: `${baseCommand}${commandSeparator(shell)}${clearVar}`,
      expectedProcess: config.expectedProcess,
      env: { [config.draftPromptEnvVar]: trimmed }
    }
  }
  return null
}

export { isShellProcess }
