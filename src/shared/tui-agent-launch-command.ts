import { resolveAgentSessionOptionLaunch } from './agent-session-option-launch'
import { getDetectedTuiAgentExecutable } from './detected-agent-executables'
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

export function resolveAgentLaunchCommand(args: {
  agent: TuiAgent
  cmdOverrides: Partial<Record<TuiAgent, string>>
  platform: NodeJS.Platform
  shell: AgentStartupShell
  agentArgs?: string | null
  sessionOptions?: Record<string, SessionOptionValue>
  isRemote?: boolean
  /** Executable detected on PATH for this agent; defaults to this process's detection result. */
  detectedCmd?: string
}): ResolvedAgentLaunchCommand {
  const override = args.cmdOverrides[args.agent]
  // Why: the ambient registry describes this machine's PATH, so a remote launch
  // must fall back to the static defaults instead of inheriting local aliases.
  const detectedCmd =
    args.detectedCmd ?? (args.isRemote ? undefined : getDetectedTuiAgentExecutable(args.agent))
  const command =
    override ||
    getTuiAgentLaunchCommand(TUI_AGENT_CONFIG[args.agent], args.platform, {
      isRemote: args.isRemote,
      ...(detectedCmd ? { detectedCmd } : {})
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
  const optionSuffix = resolvedOptions.args.map((arg) => quoteStartupArg(arg, args.shell)).join(' ')
  const commandWithOptions = optionSuffix ? `${command} ${optionSuffix}` : command
  const commandWithoutSessionOptions = suffix.suffix ? `${command} ${suffix.suffix}` : command
  // Why: session flags precede the free-form suffix so the user's explicit
  // repeated flag remains the final, winning occurrence.
  return {
    ok: true,
    command: suffix.suffix ? `${commandWithOptions} ${suffix.suffix}` : commandWithOptions,
    commandWithoutSessionOptions,
    appliedSessionOptions: resolvedOptions.appliedValues
  }
}
