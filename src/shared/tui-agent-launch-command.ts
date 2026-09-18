import {
  removeOverriddenAgentSessionArgs,
  resolveAgentSessionOptionLaunch
} from './agent-session-option-launch'
import type { SessionOptionValue } from './native-chat-session-options'
import { getTuiAgentLaunchCommand, TUI_AGENT_CONFIG } from './tui-agent-config'
import {
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
  /** Launch-only arguments omitted from persisted resume configuration. */
  transientAgentArgs?: readonly string[]
  sessionOptions?: Record<string, SessionOptionValue>
  sessionOptionsOverrideAgentArgs?: boolean
  isRemote?: boolean
}): ResolvedAgentLaunchCommand {
  const override = args.cmdOverrides[args.agent]
  const command =
    override ||
    getTuiAgentLaunchCommand(TUI_AGENT_CONFIG[args.agent], args.platform, {
      isRemote: args.isRemote
    })
  const persistedSuffix = planAgentCliArgsSuffix(args.agentArgs, args.shell)
  if (!persistedSuffix.ok) {
    return persistedSuffix
  }
  const trailingTokens = args.agentArgs?.trim()
    ? tokenizeStartupCommand(args.agentArgs.trim(), args.shell)
    : { ok: true as const, tokens: [], spans: [] }
  if (!trailingTokens.ok) {
    return { ok: false, error: `CLI arguments are invalid: ${trailingTokens.error}` }
  }
  const launchTokens = insertBeforeTerminator(trailingTokens.tokens, args.transientAgentArgs ?? [])
  const launchSuffix = launchTokens.map((token) => quoteStartupArg(token, args.shell)).join(' ')
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
  const commandWithoutSessionOptions = persistedSuffix.suffix
    ? `${command} ${persistedSuffix.suffix}`
    : command
  const commandWithOptions = optionSuffix ? `${command} ${optionSuffix}` : command
  const overrideTokens = args.sessionOptionsOverrideAgentArgs
    ? insertBeforeTerminator(
        insertBeforeTerminator(
          removeOverriddenAgentSessionArgs(args.agent, args.sessionOptions, trailingTokens.tokens),
          resolvedOptions.args
        ),
        args.transientAgentArgs ?? []
      )
    : []
  const commandWithOverrides = overrideTokens.length
    ? `${command} ${overrideTokens.map((token) => quoteStartupArg(token, args.shell)).join(' ')}`
    : command
  return {
    ok: true,
    command: args.sessionOptionsOverrideAgentArgs
      ? commandWithOverrides
      : launchSuffix
        ? `${commandWithOptions} ${launchSuffix}`
        : commandWithOptions,
    commandWithoutSessionOptions,
    appliedSessionOptions: resolvedOptions.appliedValues
  }
}

function insertBeforeTerminator(tokens: readonly string[], inserted: readonly string[]): string[] {
  const terminator = tokens.indexOf('--')
  if (terminator === -1) {
    return [...tokens, ...inserted]
  }
  return [...tokens.slice(0, terminator), ...inserted, ...tokens.slice(terminator)]
}
