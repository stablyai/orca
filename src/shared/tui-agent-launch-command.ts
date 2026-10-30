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
  codex: ['-c', 'check_for_update_on_startup=false'],
  aider: ['--no-check-update', '--no-show-release-notes'],
  cursor: ['--disable-auto-update']
}

const STARTUP_UPDATE_PROMPT_SUPPRESSION_ENV: Partial<
  Record<TuiAgent, Readonly<Record<string, string>>>
> = {
  claude: { DISABLE_AUTOUPDATER: '1' },
  'claude-agent-teams': { DISABLE_AUTOUPDATER: '1' },
  opencode: { OPENCODE_DISABLE_AUTOUPDATE: 'true' },
  opencode2: { OPENCODE_DISABLE_AUTOUPDATE: 'true' },
  antigravity: { AGY_CLI_DISABLE_AUTO_UPDATE: 'true' },
  grok: { GROK_DISABLE_AUTOUPDATER: '1' },
  pi: { PI_SKIP_VERSION_CHECK: '1' },
  kimi: { KIMI_CODE_NO_AUTO_UPDATE: '1', KIMI_CLI_NO_AUTO_UPDATE: '1' }
}

// Why not win32: Codex there reads console input records and needs its burst for pastes (windowsInputRecordPasteNewline).
// Elsewhere Orca's terminals bracket every paste, so the burst can only misread relayed typing (#34496).
function agentTerminalInputArgs(
  agent: TuiAgent,
  platform: NodeJS.Platform | null
): readonly string[] {
  return agent === 'codex' && platform !== null && platform !== 'win32'
    ? ['-c', 'disable_paste_burst=true']
    : []
}

function isCodexExecutable(token: string | undefined): boolean {
  const basename = token?.split(/[\\/]/).pop()?.toLowerCase()
  return basename !== undefined && /^codex(?:\.(?:exe|cmd|bat|ps1))?$/.test(basename)
}

/** Appends the per-launch terminal input flags to a recorded agent command. */
export function withAgentTerminalInputArgs(
  command: string,
  agent: TuiAgent,
  /** OS that runs the agent; null when the host has not reported it. */
  platform: NodeJS.Platform | null,
  shell: AgentStartupShell
): string {
  const inputArgs = agentTerminalInputArgs(agent, platform)
  const tokens = tokenizeStartupCommand(command, shell)
  // Why: only a lone Codex invocation is safe; a wrapper may not forward -c, a compound line would
  // hand it to another command, and the command may already set it or end its options with `--`.
  return inputArgs.length &&
    !/[;&|<>`$()\n]/.test(command) &&
    tokens.ok &&
    isCodexExecutable(tokens.tokens[0]) &&
    !command.includes('disable_paste_burst') &&
    !tokens.tokens.includes('--')
    ? `${command} ${inputArgs.map((arg) => quoteStartupArg(arg, shell)).join(' ')}`
    : command
}

export type ResolvedAgentLaunchCommand =
  | {
      ok: true
      command: string
      resumeLaunch: { agentCommand: string; agentArgs?: string }
      appliedSessionOptions: Record<string, SessionOptionValue>
      startupEnv?: Readonly<Record<string, string>>
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
  /** OS that runs the agent when `platform` only picks quoting; null when unreported. */
  agentHostPlatform?: NodeJS.Platform | null
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
  const prefixSuppressionArgs = args.agent === 'aider' ? [] : suppressionArgs
  const launchHead = withAgentTerminalInputArgs(
    prefixSuppressionArgs.length
      ? `${command} ${prefixSuppressionArgs.map((arg) => quoteStartupArg(arg, args.shell)).join(' ')}`
      : command,
    args.agent,
    args.agentHostPlatform === undefined ? args.platform : args.agentHostPlatform,
    args.shell
  )
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
  // Aider's last boolean flag wins, even over configured --check-update.
  const launchTokens =
    args.agent === 'aider'
      ? insertBeforeTerminator(args.agent, initialTokens, suppressionArgs)
      : initialTokens
  // Restart retains explicit policy and surviving raw pins, while providers restore model seeds.
  const resumeArgs = render(
    insertBeforeTerminator(args.agent, keptTokens, resolvedOptions.permissionArgs ?? [])
  )
  return {
    ok: true,
    command: withArgs(render(launchTokens), launchHead),
    resumeLaunch: {
      agentCommand: withArgs(resumeArgs),
      ...(keptTokens.length !== rawTokens.length ||
      keptTokens.some((token, index) => token !== rawTokens[index]) ||
      resolvedOptions.permissionArgs
        ? { agentArgs: resumeArgs }
        : {})
    },
    appliedSessionOptions: resolvedOptions.appliedValues,
    ...(args.suppressStartupUpdatePrompt && STARTUP_UPDATE_PROMPT_SUPPRESSION_ENV[args.agent]
      ? { startupEnv: STARTUP_UPDATE_PROMPT_SUPPRESSION_ENV[args.agent] }
      : {})
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
