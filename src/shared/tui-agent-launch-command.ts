import {
  removeOverriddenAgentSessionArgs,
  resolveAgentSessionOptionLaunch
} from './agent-session-option-launch'
import type { SessionOptionValue } from './native-chat-session-options'
import { getTuiAgentLaunchCommand, TUI_AGENT_CONFIG } from './tui-agent-config'
import {
  isPosixStartupShell,
  planAgentCliArgsSuffix,
  quoteStartupArg,
  tokenizeStartupCommand,
  type AgentStartupShell
} from './tui-agent-startup-shell'
import type { TuiAgent } from './tui-agent'

export type ResolvedAgentLaunchCommand =
  | {
      ok: true
      command: string
      commandWithoutSessionOptions: string
      appliedSessionOptions: Record<string, SessionOptionValue>
    }
  | { ok: false; error: string }

export function resolveAgentLaunchCommand(args: {
  agent: TuiAgent
  cmdOverrides: Partial<Record<TuiAgent, string>>
  platform: NodeJS.Platform
  shell: AgentStartupShell
  agentArgs?: string | null
  sessionOptions?: Record<string, SessionOptionValue>
  sessionOptionsOverrideAgentArgs?: boolean
  isRemote?: boolean
}): ResolvedAgentLaunchCommand {
  const config = TUI_AGENT_CONFIG[args.agent]
  const override = args.cmdOverrides[args.agent]
  const launchCommand =
    override ||
    getTuiAgentLaunchCommand(config, args.platform, {
      isRemote: args.isRemote
    })
  const launchArgs = config.launchArgs ?? []
  const quotedLaunchArgs = launchArgs.map((arg) => quoteStartupArg(arg, args.shell)).join(' ')
  const command =
    override && quotedLaunchArgs
      ? insertLaunchArgsIntoOverride(
          override,
          quotedLaunchArgs,
          [config.detectCmd, ...(config.detectCmdAliases ?? [])],
          args.shell
        )
      : quotedLaunchArgs
        ? `${launchCommand} ${quotedLaunchArgs}`
        : launchCommand
  const suffix = planAgentCliArgsSuffix(args.agentArgs, args.shell)
  if (!suffix.ok) {
    return suffix
  }
  const trailingTokens = args.agentArgs?.trim()
    ? tokenizeStartupCommand(args.agentArgs.trim(), args.shell)
    : { ok: true as const, tokens: [], spans: [] }
  if (!trailingTokens.ok) {
    return { ok: false, error: `CLI arguments are invalid: ${trailingTokens.error}` }
  }
  const resolvedOptions = resolveAgentSessionOptionLaunch(
    args.agent,
    args.sessionOptions,
    args.sessionOptionsOverrideAgentArgs ? [] : trailingTokens.tokens,
    !args.sessionOptionsOverrideAgentArgs
  )
  if (override && args.sessionOptionsOverrideAgentArgs) {
    const overrideTokens = tokenizeStartupCommand(override, args.shell)
    if (!overrideTokens.ok) {
      return { ok: false, error: `Agent command override is invalid: ${overrideTokens.error}` }
    }
    const commandOverrideOptions = resolveAgentSessionOptionLaunch(
      args.agent,
      args.sessionOptions,
      overrideTokens.tokens,
      false
    )
    if (
      Object.entries(resolvedOptions.appliedValues).some(
        ([key, value]) => commandOverrideOptions.appliedValues[key] !== value
      )
    ) {
      return {
        ok: false,
        error:
          'Agent command override conflicts with the requested launch preferences. Remove model or effort flags from the command override.'
      }
    }
  }
  const optionSuffix = resolvedOptions.args.map((arg) => quoteStartupArg(arg, args.shell)).join(' ')
  const commandWithoutSessionOptions = suffix.suffix ? `${command} ${suffix.suffix}` : command
  const commandWithOptions = optionSuffix ? `${command} ${optionSuffix}` : command
  const overrideTokens = args.sessionOptionsOverrideAgentArgs
    ? insertBeforeTerminator(
        removeOverriddenAgentSessionArgs(args.agent, args.sessionOptions, trailingTokens.tokens),
        resolvedOptions.args
      )
    : []
  const commandWithOverrides = overrideTokens.length
    ? `${command} ${overrideTokens.map((token) => quoteStartupArg(token, args.shell)).join(' ')}`
    : command
  return {
    ok: true,
    command: args.sessionOptionsOverrideAgentArgs
      ? commandWithOverrides
      : suffix.suffix
        ? `${commandWithOptions} ${suffix.suffix}`
        : commandWithOptions,
    commandWithoutSessionOptions,
    appliedSessionOptions: resolvedOptions.appliedValues
  }
}

/**
 * Inserts Orca-owned arguments immediately after a directly invoked agent binary.
 * User override arguments therefore stay later (and can override defaults), while
 * an option terminator cannot turn the injected arguments into positional input.
 */
function insertLaunchArgsIntoOverride(
  command: string,
  quotedLaunchArgs: string,
  executableNames: readonly string[],
  shell: AgentStartupShell
): string {
  const tokenized = tokenizeStartupCommand(command, shell)
  if (!tokenized.ok) {
    return command
  }
  const normalizedNames = new Set(executableNames.map(normalizeExecutableName))
  let commandPosition = true
  for (let index = 0; index < tokenized.tokens.length; index += 1) {
    const token = tokenized.tokens[index]
    if (commandPosition && normalizedNames.has(normalizeExecutableName(token))) {
      const insertionPoint = tokenized.spans[index].end
      return `${command.slice(0, insertionPoint)} ${quotedLaunchArgs}${command.slice(insertionPoint)}`
    }
    if (commandPosition) {
      if (isPosixStartupShell(shell) && /^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
        continue
      }
      if (shell === 'powershell' && index === 0 && token === '&') {
        continue
      }
      commandPosition = false
    }
  }
  return command
}

function normalizeExecutableName(commandToken: string): string {
  const basename = commandToken.split(/[\\/]/).pop() ?? ''
  return basename.replace(/\.(exe|cmd|bat|ps1)$/i, '').toLowerCase()
}

function insertBeforeTerminator(tokens: readonly string[], inserted: readonly string[]): string[] {
  const terminator = tokens.indexOf('--')
  if (terminator === -1) {
    return [...tokens, ...inserted]
  }
  return [...tokens.slice(0, terminator), ...inserted, ...tokens.slice(terminator)]
}
