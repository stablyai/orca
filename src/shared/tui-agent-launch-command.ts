import {
  removeOverriddenAgentSessionArgs,
  resolveAgentSessionOptionLaunch
} from './agent-session-option-launch'
import type { SessionOptionValue } from './native-chat/input/native-chat-session-options'
import { agentArgTerminatorIndex } from './agent-session-option-agent-args'
import { getTuiAgentLaunchCommand, TUI_AGENT_CONFIG } from './tui-agent-config'
import {
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
      resumeLaunch: { agentCommand: string; agentArgs?: string }
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
    !args.sessionOptionsOverrideAgentArgs,
    trailingTokens.tokens
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
          'Agent command override conflicts with the requested launch preferences. Remove model, effort or permission flags from the command override.'
      }
    }
  }
  const rawTokens = trailingTokens.tokens
  const keptTokens = args.sessionOptionsOverrideAgentArgs
    ? removeOverriddenAgentSessionArgs(args.agent, resolvedOptions.appliedValues, rawTokens)
    : rawTokens
  const render = (tokens: readonly string[]): string =>
    tokens.map((token) => quoteStartupArg(token, args.shell)).join(' ')
  const withArgs = (suffix: string, head = command): string => (suffix ? `${head} ${suffix}` : head)
  const initialTokens = args.sessionOptionsOverrideAgentArgs
    ? insertBeforeTerminator(args.agent, keptTokens, resolvedOptions.args)
    : [...resolvedOptions.args, ...keptTokens]
  // Restart retains explicit policy and surviving raw pins, while providers restore model seeds.
  const resumeArgs = render(
    insertBeforeTerminator(args.agent, keptTokens, resolvedOptions.permissionArgs ?? [])
  )
  return {
    ok: true,
    command: withArgs(render(initialTokens), launchHead),
    resumeLaunch: {
      agentCommand: withArgs(resumeArgs),
      ...(keptTokens.length !== rawTokens.length || resolvedOptions.permissionArgs
        ? { agentArgs: resumeArgs }
        : {})
    },
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

/** A launch's saved choice as terminal startup inputs: flags that replace conflicting raw ones, or,
 *  when it yields to these CLI arguments, only the pieces they do not set themselves. */
export function terminalSessionOptionInputs(args: {
  agent: TuiAgent
  sessionOptions: Readonly<Record<string, SessionOptionValue>> | undefined
  yieldToAgentArgs?: boolean
  agentArgs: string | null | undefined
  shell: AgentStartupShell
}): {
  sessionOptions?: Record<string, SessionOptionValue>
  sessionOptionsOverrideAgentArgs?: true
} {
  const tokens = args.agentArgs?.trim()
    ? tokenizeStartupCommand(args.agentArgs.trim(), args.shell)
    : null
  const sessionOptions =
    args.sessionOptions && args.yieldToAgentArgs && tokens?.ok
      ? resolveAgentSessionOptionLaunch(
          args.agent,
          { ...args.sessionOptions },
          tokens.tokens,
          false
        ).appliedValues
      : args.sessionOptions && { ...args.sessionOptions }
  return sessionOptions && Object.keys(sessionOptions).length > 0
    ? { sessionOptions, sessionOptionsOverrideAgentArgs: true }
    : {}
}
