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
import { planCodexRemoteHookLaunchArgs } from './codex-remote-hook-launch'
import {
  areAgentStatusHooksEnabledForAgent,
  type AgentStatusHookSettings
} from './agent-status-hooks-for-agent'

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
  /** Settings deciding Orca's managed status hooks. Resolved here rather than by
   *  each caller: a remote Codex launch carries a launch-scoped hooks override so
   *  the TUI does not attach to an app-server that never saw the pane's hook env,
   *  and every launch surface used to have to remember that for itself (#11941). */
  agentStatusHookSettings: AgentStatusHookSettings | null
}): ResolvedAgentLaunchCommand {
  const override = args.cmdOverrides[args.agent]
  const baseLaunchCommand =
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
  const hookArgs = planCodexRemoteHookLaunchArgs({
    agent: args.agent,
    platform: args.platform,
    isRemote: args.isRemote,
    hooksEnabled: areAgentStatusHooksEnabledForAgent(args.agentStatusHookSettings, args.agent),
    launchTokens: [...tokenizeCommandOverride(override, args.shell), ...trailingTokens.tokens]
  })
  const command = hookArgs.length
    ? `${baseLaunchCommand} ${hookArgs.map((arg) => quoteStartupArg(arg, args.shell)).join(' ')}`
    : baseLaunchCommand
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

function insertBeforeTerminator(tokens: readonly string[], inserted: readonly string[]): string[] {
  const terminator = tokens.indexOf('--')
  if (terminator === -1) {
    return [...tokens, ...inserted]
  }
  return [...tokens.slice(0, terminator), ...inserted, ...tokens.slice(terminator)]
}

// Why: an override can name the agent's own hooks decision, so its tokens have
// to be visible to the remote-hook planner. A malformed override is not this
// function's error to raise — it is reported by the existing override check.
function tokenizeCommandOverride(
  override: string | undefined,
  shell: AgentStartupShell
): readonly string[] {
  if (!override) {
    return []
  }
  const tokens = tokenizeStartupCommand(override, shell)
  return tokens.ok ? tokens.tokens : []
}
