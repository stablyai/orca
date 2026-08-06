import { resolveAgentSessionOptionLaunch } from './agent-session-option-launch'
import type { SessionOptionValue } from './native-chat-session-options'
import { getTuiAgentLaunchCommand, TUI_AGENT_CONFIG } from './tui-agent-config'
import {
  planAgentCliArgsSuffix,
  quoteStartupArg,
  tokenizeStartupCommand,
  type AgentStartupShell
} from './tui-agent-startup-shell'
import type { TuiAgent } from './types'

export type ResolvedAgentLaunchCommand =
  | {
      ok: true
      command: string
      commandWithoutSessionOptions: string
      appliedSessionOptions: Record<string, SessionOptionValue>
    }
  | { ok: false; error: string }

const REMOTE_CODEX_HOOK_FEATURE_ARGS = '${ORCA_AGENT_HOOK_PORT:+--enable hooks}'

function hasCodexHooksFeatureOverride(tokens: readonly string[]): boolean {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    const next = tokens[index + 1]
    if (
      ((token === '--enable' || token === '--disable') && next === 'hooks') ||
      token === '--enable=hooks' ||
      token === '--disable=hooks' ||
      ((token === '-c' || token === '--config') && next?.startsWith('features.hooks=')) ||
      token.startsWith('-cfeatures.hooks=') ||
      token.startsWith('--config=features.hooks=')
    ) {
      return true
    }
  }
  return false
}

function commandHasCodexHooksFeatureOverride(command: string, shell: AgentStartupShell): boolean {
  if (command.includes(REMOTE_CODEX_HOOK_FEATURE_ARGS)) {
    return true
  }
  const tokenized = tokenizeStartupCommand(command, shell)
  return tokenized.ok && hasCodexHooksFeatureOverride(tokenized.tokens)
}

function enableRemoteCodexHooksForOrcaPty(args: {
  agent: TuiAgent
  command: string
  shell: AgentStartupShell
  isRemote?: boolean
  trailingTokens?: readonly string[]
}): string {
  if (
    args.agent !== 'codex' ||
    args.isRemote !== true ||
    args.shell !== 'posix' ||
    commandHasCodexHooksFeatureOverride(args.command, args.shell) ||
    hasCodexHooksFeatureOverride(args.trailingTokens ?? [])
  ) {
    return args.command
  }
  // Why: remote Codex can reuse a long-lived app-server that predates the PTY
  // and therefore lacks Orca's per-pane hook env. A launch-only feature flag
  // keeps hook execution in the PTY environment, while the POSIX expansion
  // emits no arguments when agent status hooks are disabled for that PTY.
  return `${args.command} ${REMOTE_CODEX_HOOK_FEATURE_ARGS}`
}

export function resolveAgentLaunchCommand(args: {
  agent: TuiAgent
  cmdOverrides: Partial<Record<TuiAgent, string>>
  platform: NodeJS.Platform
  shell: AgentStartupShell
  agentArgs?: string | null
  sessionOptions?: Record<string, SessionOptionValue>
  isRemote?: boolean
}): ResolvedAgentLaunchCommand {
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
  const trailingTokens = args.agentArgs?.trim()
    ? tokenizeStartupCommand(args.agentArgs.trim(), args.shell)
    : { ok: true as const, tokens: [] }
  if (!trailingTokens.ok) {
    return { ok: false, error: `CLI arguments are invalid: ${trailingTokens.error}` }
  }
  const resolvedOptions = resolveAgentSessionOptionLaunch(
    args.agent,
    args.sessionOptions,
    trailingTokens.tokens
  )
  const hookAwareCommand = enableRemoteCodexHooksForOrcaPty({
    agent: args.agent,
    command,
    shell: args.shell,
    isRemote: args.isRemote,
    trailingTokens: trailingTokens.tokens
  })
  const optionSuffix = resolvedOptions.args.map((arg) => quoteStartupArg(arg, args.shell)).join(' ')
  const commandWithOptions = optionSuffix ? `${hookAwareCommand} ${optionSuffix}` : hookAwareCommand
  const commandWithoutSessionOptions = suffix.suffix
    ? `${hookAwareCommand} ${suffix.suffix}`
    : hookAwareCommand
  // Why: session flags precede the free-form suffix so the user's explicit
  // repeated flag remains the final, winning occurrence.
  return {
    ok: true,
    command: suffix.suffix ? `${commandWithOptions} ${suffix.suffix}` : commandWithOptions,
    commandWithoutSessionOptions,
    appliedSessionOptions: resolvedOptions.appliedValues
  }
}
