import { tokenizeCustomCommandTemplate } from './commit-message-prompt'
import { TUI_AGENT_CONFIG } from './tui-agent-config'
import { resolveTuiAgentLaunchCommandOverride } from './tui-agent-launch-defaults'
import { resolveTuiAgentBaseAgent, type TuiAgentProfileVariables } from './tui-agent-profiles'
import type { TuiAgent, TuiAgentProfile } from './types'

export type AgentStartupShell = 'posix' | 'powershell' | 'cmd'

export type AgentCliArgsPlan = { ok: true; suffix: string } | { ok: false; error: string }

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

export function resolveAgentStartupBaseCommand(args: {
  agent: TuiAgent
  cmdOverrides: Partial<Record<TuiAgent, string>>
  shell: AgentStartupShell
  agentArgs?: string | null
  agentProfiles?: readonly TuiAgentProfile[] | null
  variables?: TuiAgentProfileVariables | null
}): { ok: true; command: string } | { ok: false; error: string } {
  const baseAgent = resolveTuiAgentBaseAgent(args.agent, args.agentProfiles)
  if (!baseAgent) {
    return { ok: false, error: 'Unknown agent profile.' }
  }
  const override = resolveTuiAgentLaunchCommandOverride(
    args.agent,
    args.cmdOverrides,
    args.agentProfiles,
    args.variables
  )
  const command = override || TUI_AGENT_CONFIG[baseAgent].launchCmd
  const suffix = planAgentCliArgsSuffix(args.agentArgs, args.shell)
  if (!suffix.ok) {
    return suffix
  }
  // Why: Codex status hooks live in Orca's runtime CODEX_HOME; adding
  // --profile-v2 makes Codex load a second hook representation and warn.
  return { ok: true, command: suffix.suffix ? `${command} ${suffix.suffix}` : command }
}
