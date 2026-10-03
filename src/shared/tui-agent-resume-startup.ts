import {
  getAgentResumeArgv,
  type AgentProviderSessionMetadata,
  type ResumableTuiAgent
} from './agent-session-resume'
import type { SessionOptionValue } from './native-chat-session-options'
import { buildSleepingAgentLaunchConfig } from './sleeping-agent-launch-config'
import { resolveAgentLaunchCommand } from './tui-agent-launch-command'
import type { AgentStartupPlan } from './tui-agent-startup'
import { resolveStartupShell, type AgentStartupShell } from './tui-agent-startup-shell'
import { TUI_AGENT_CONFIG } from './tui-agent-config'
import type { TuiAgent } from './tui-agent'
import { buildAgentResumeLaunchCommand } from './agent-resume-launch-command'
import {
  isWrapperTextSafeToAppendResume,
  stripLeadingEnvAssignments,
  stripStaleResumeSelectors
} from './quick-command-resume'
import { recognizeAgentProcessFromCommandLine } from './agent-process-recognition'

// `[bin, '--resume', id]` → `--resume`; `[bin, 'resume', id]` (codex, muse)
// → the `resume` subcommand; `[bin, '--resume=id']` (copilot) → `--resume`.
function resolveAgentResumeFlag(argv: readonly string[]): string | undefined {
  if (argv.length >= 3) {
    return argv.at(-2)
  }
  const joined = argv.at(-1)
  return joined?.startsWith('-') && joined.includes('=')
    ? joined.slice(0, joined.indexOf('='))
    : undefined
}

export function buildAgentResumeStartupPlan(args: {
  agent: ResumableTuiAgent
  providerSession: AgentProviderSessionMetadata
  cmdOverrides: Partial<Record<TuiAgent, string>>
  platform: NodeJS.Platform
  shell?: AgentStartupShell
  agentArgs?: string | null
  agentEnv?: Record<string, string> | null
  agentCommand?: string | null
  ompResumeFilePath?: string | null
  /** Why: a terminal-command Quick Command wrapper (e.g. `ccr muse`) that
   *  spawned this tab, resolved to its CURRENT text at resume time. Wins over
   *  agentCommand/cmdOverrides so the restored tab keeps the user's route. */
  quickCommandText?: string | null
  quickCommandId?: string | null
  quickCommandLabel?: string | null
  /** Why: a Quick Command stamp records empty args/env because the wrapper
   *  text is complete. When the wrapper cannot be used, the stock command
   *  must still get the user's defaults, like any unstamped tab. */
  quickCommandFallbackAgentArgs?: string | null
  quickCommandFallbackAgentEnv?: Record<string, string> | null
  sessionOptions?: Record<string, SessionOptionValue>
  sessionOptionsOverrideAgentArgs?: boolean
  isRemote?: boolean
}): AgentStartupPlan | null {
  const argv = getAgentResumeArgv(args.agent, args.providerSession, args.ompResumeFilePath)
  if (!argv) {
    return null
  }
  const shell = resolveStartupShell(args.platform, args.shell)
  // Why: a resolved wrapper is an EXECUTABLE base, never the persisted
  // fallback command — if the Quick Command is later deleted, resolvers
  // return null and resume must fall back to stock, not replay a cached
  // copy of the deleted text (which agentCommand would otherwise keep).
  // The append-safety gate keeps shell syntax (`ccr muse --resume && notify`)
  // from receiving the appended session id as its LAST command's argument.
  const trimmedQuickCommandText = args.quickCommandText?.trim() ?? ''
  // Why: claude strips every selector shape its guard knows; other agents
  // strip only their own resume selector (`--resume`, `--session`, or the
  // codex/muse `resume` subcommand) so e.g. codex `-c key=value` survives.
  // Selectors are cut only after the agent binary when the text names it, so
  // a preceding wrapper's own flags (`nix develop -c claude`) are kept.
  const agentResumeFlag = resolveAgentResumeFlag(argv)
  const agentBinary = argv[0]
  // Why: text that launches a different agent directly (`claude ...` for a
  // codex session) would resume the wrong binary; fall back to stock.
  const quickCommandAgent = trimmedQuickCommandText
    ? recognizeAgentProcessFromCommandLine(stripLeadingEnvAssignments(trimmedQuickCommandText), {
        includeHeadlessOneShot: true
      })?.agent
    : undefined
  const resolvedQuickCommandText =
    trimmedQuickCommandText &&
    (quickCommandAgent === undefined || quickCommandAgent === args.agent) &&
    isWrapperTextSafeToAppendResume(trimmedQuickCommandText, shell)
      ? args.agent === 'claude'
        ? stripStaleResumeSelectors(trimmedQuickCommandText, shell, { agentBinary })
        : agentResumeFlag
          ? stripStaleResumeSelectors(trimmedQuickCommandText, shell, {
              agentBinary,
              resumeFlag: agentResumeFlag,
              resumeFlagJoined: argv.length < 3
            })
          : trimmedQuickCommandText
      : ''
  const useQuickCommandFallbackDefaults =
    !resolvedQuickCommandText &&
    (args.quickCommandFallbackAgentArgs !== undefined ||
      args.quickCommandFallbackAgentEnv !== undefined)
  const agentArgs = useQuickCommandFallbackDefaults
    ? args.quickCommandFallbackAgentArgs
    : args.agentArgs
  const agentEnv = useQuickCommandFallbackDefaults
    ? args.quickCommandFallbackAgentEnv
    : args.agentEnv
  const resolvedAgentCommand = args.agentCommand?.trim()
  const baseCommand = resolvedQuickCommandText
    ? ({
        ok: true,
        command: resolvedQuickCommandText,
        commandWithoutSessionOptions: '',
        appliedSessionOptions: {}
      } as const)
    : resolvedAgentCommand
      ? ({
          ok: true,
          command: resolvedAgentCommand,
          commandWithoutSessionOptions: resolvedAgentCommand,
          appliedSessionOptions: {}
        } as const)
      : resolveAgentLaunchCommand({
          agent: args.agent,
          cmdOverrides: args.cmdOverrides,
          platform: args.platform,
          shell,
          agentArgs,
          sessionOptions: args.sessionOptions,
          sessionOptionsOverrideAgentArgs: args.sessionOptionsOverrideAgentArgs,
          isRemote: args.isRemote
        })
  if (!baseCommand.ok) {
    return null
  }
  const launchConfig = buildSleepingAgentLaunchConfig({
    ...args,
    agentArgs,
    agentEnv,
    // Why: `...args` carries quickCommandId/Label already; agentCommand here
    // is ONLY the stock fallback (never wrapper text), so a deleted Quick
    // Command retires its route instead of replaying it from cache.
    agentCommand: resolvedQuickCommandText ? undefined : baseCommand.commandWithoutSessionOptions
  })
  const launchCommand = buildAgentResumeLaunchCommand(args.agent, baseCommand.command, argv, shell)
  const applied = baseCommand.appliedSessionOptions
  return {
    agent: args.agent,
    launchCommand,
    expectedProcess: TUI_AGENT_CONFIG[args.agent].expectedProcess,
    followupPrompt: null,
    launchConfig,
    ...(args.agent === 'codex' ? { startupCommandDelivery: 'shell-ready' as const } : {}),
    ...(Object.keys(applied).length > 0 ? { sessionOptions: { ...applied } } : {}),
    ...(agentEnv ? { env: { ...agentEnv } } : {})
  }
}
