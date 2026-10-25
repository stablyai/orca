import {
  removeOverriddenAgentSessionArgs,
  resolveAgentSessionOptionLaunch
} from './agent-session-option-launch'
import type { SessionOptionValue } from './native-chat-session-options'
import { agentArgTerminatorIndex } from './agent-session-option-agent-args'
import { getTuiAgentLaunchCommand, TUI_AGENT_CONFIG } from './tui-agent-config'
import {
  planAgentCliArgsSuffix,
  quoteStartupArg,
  tokenizeStartupCommand,
  type AgentStartupShell
} from './tui-agent-startup-shell'
import type { TuiAgent } from './tui-agent'

// Why: Enter on Codex's "Update available" screen picks "Update now", which installs and exits.
const STARTUP_UPDATE_PROMPT_SUPPRESSION_ARGS: Partial<Record<TuiAgent, readonly string[]>> = {
  codex: ['-c', 'check_for_update_on_startup=false']
}

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
  /** Launch-only, like session options: a resumed session must not inherit it. */
  suppressStartupUpdatePrompt?: boolean
}): ResolvedAgentLaunchCommand {
  const override = args.cmdOverrides[args.agent]
  const command =
    override ||
    getTuiAgentLaunchCommand(TUI_AGENT_CONFIG[args.agent], args.platform, {
      isRemote: args.isRemote
    })
  const suppressionArgs = args.suppressStartupUpdatePrompt
    ? (STARTUP_UPDATE_PROMPT_SUPPRESSION_ARGS[args.agent] ?? [])
    : []
  const launchHead = suppressionArgs.length
    ? `${command} ${suppressionArgs.map((arg) => quoteStartupArg(arg, args.shell)).join(' ')}`
    : command
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
  const commandWithOptions = optionSuffix ? `${launchHead} ${optionSuffix}` : launchHead
  const overrideTokens = args.sessionOptionsOverrideAgentArgs
    ? insertBeforeTerminator(
        args.agent,
        removeOverriddenAgentSessionArgs(args.agent, args.sessionOptions, trailingTokens.tokens),
        resolvedOptions.args
      )
    : []
  const commandWithOverrides = overrideTokens.length
    ? `${launchHead} ${overrideTokens.map((token) => quoteStartupArg(token, args.shell)).join(' ')}`
    : launchHead
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

function insertBeforeTerminator(
  agent: TuiAgent,
  tokens: readonly string[],
  inserted: readonly string[]
): string[] {
  const terminator = agentArgTerminatorIndex(agent, tokens)
  return [...tokens.slice(0, terminator), ...inserted, ...tokens.slice(terminator)]
}
