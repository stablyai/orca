import { analyzeAgentChoiceArgs } from '../choices/agent-choice-args'
import {
  removeOverriddenAgentSessionArgs,
  resolveAgentSessionOptionLaunch
} from '../../agent-session/options/launch/agent-session-option-launch'
import { resolveAgentChoiceLayers, yieldAgentChoicesToArgs } from '../choices/agent-choice-layers'
import { resolveTuiAgentLaunchRawArgs } from '../choices/tui-agent-launch-defaults'
import {
  hasExtraAgentArgs,
  parseExtraAgentArgs,
  mergeParsedExtraAgentArgs
} from './automation-extra-agent-args'
import type { AgentLaunchProfileSettings } from '../choices/tui-agent-launch-defaults'
import { readLaunchPermissionChoice } from '../permissions/tui-agent-permission-choice'
import type { SessionOptionValue } from '../../native-chat/input/native-chat-session-options'
import { agentArgTerminatorIndex } from '../../agent-session/options/launch/agent-session-option-agent-args'
import { getTuiAgentLaunchCommand, TUI_AGENT_CONFIG } from '../catalog/tui-agent-config'
import {
  quoteStartupArg,
  tokenizeStartupCommand,
  type AgentStartupShell
} from './tui-agent-startup-shell'
import type { TuiAgent } from '../catalog/tui-agent'
import {
  launchCommandProvenance,
  stockLaunchProgram,
  withManagedAgentProgram,
  type ManagedAgentCommands
} from './managed-agent-launch-program'
import { withAgentTerminalInputArgs } from './codex-terminal-input-args'
import { antigravityModelArgs } from './antigravity-resume-model-args'
import {
  STARTUP_UPDATE_PROMPT_SUPPRESSION_ARGS,
  STARTUP_UPDATE_PROMPT_SUPPRESSION_ENV
} from './agent-startup-update-prompt'

export type ResolvedAgentLaunchCommand =
  | {
      ok: true
      command: string
      resumeLaunch: {
        agentCommand: string
        agentArgs?: string
        commandProvenance: 'authored' | 'generated'
        authoredCommand?: string
        selectedExecutable?: string
      }
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
  managedAgentCommands?: ManagedAgentCommands | null
}): ResolvedAgentLaunchCommand {
  const override =
    args.cmdOverrides[args.agent] ??
    (args.agent === 'claude-agent-teams' ? args.cmdOverrides.claude : undefined)
  const commandProvenance = launchCommandProvenance(
    override,
    stockLaunchProgram(args.agent, args.platform, args.isRemote),
    args.platform
  )
  const command =
    (commandProvenance === 'authored' ? override : override?.trim()) ||
    getTuiAgentLaunchCommand(TUI_AGENT_CONFIG[args.agent], args.platform, {
      isRemote: args.isRemote
    })
  // Saved sessions resolve the stock program on their current host.
  const program =
    commandProvenance === 'generated' ? withManagedAgentProgram(command, args) : command
  const suppressionArgs = args.suppressStartupUpdatePrompt
    ? (STARTUP_UPDATE_PROMPT_SUPPRESSION_ARGS[args.agent] ?? [])
    : []
  const prefixSuppressionArgs = args.agent === 'aider' ? [] : suppressionArgs
  const launchHead = withAgentTerminalInputArgs(
    prefixSuppressionArgs.length
      ? `${program} ${prefixSuppressionArgs.map((arg) => quoteStartupArg(arg, args.shell)).join(' ')}`
      : program,
    args.agent,
    commandProvenance === 'authored'
      ? null
      : args.agentHostPlatform === undefined
        ? args.platform
        : args.agentHostPlatform,
    args.shell
  )
  const trailingTokens: ReturnType<typeof tokenizeStartupCommand> = args.agentArgs?.trim()
    ? tokenizeStartupCommand(args.agentArgs.trim(), args.shell)
    : { ok: true, tokens: [], spans: [] }
  if (!trailingTokens.ok) {
    return { ok: false, error: `CLI arguments are invalid: ${trailingTokens.error}` }
  }
  const sourceModels =
    args.sessionOptions && !args.sessionOptions.model && args.agentArgs
      ? analyzeAgentChoiceArgs(args.agent, args.agentArgs).occurrences.filter(
          (entry) => entry.key === 'model' && entry.source
        )
      : []
  const modelContext = sourceModels.length === 1 ? sourceModels[0].value : undefined
  const resolvedOptions = resolveAgentSessionOptionLaunch(
    args.agent,
    args.sessionOptions,
    args.sessionOptionsOverrideAgentArgs ? [] : trailingTokens.tokens,
    !args.sessionOptionsOverrideAgentArgs,
    trailingTokens.tokens,
    modelContext
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
      false,
      overrideTokens.tokens,
      modelContext
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
  // Restart retains explicit policy and surviving raw pins. agy --conversation also needs the
  // launch's --model or custom models fail with "model is empty" (#43154); --effort stays out
  // because combining it with --model makes agy run a different model (#39556).
  const resumeOptionArgs =
    args.agent === 'antigravity'
      ? [...antigravityModelArgs(resolvedOptions.args), ...(resolvedOptions.permissionArgs ?? [])]
      : (resolvedOptions.permissionArgs ?? [])
  const resumeArgs = render(insertBeforeTerminator(args.agent, keptTokens, resumeOptionArgs))
  const launchArgs = render(launchTokens)
  return {
    ok: true,
    command: withArgs(launchArgs, launchHead),
    resumeLaunch: {
      agentCommand: withArgs(resumeArgs),
      commandProvenance,
      ...(commandProvenance === 'authored' &&
      (args.agent === 'claude' || args.agent === 'claude-agent-teams')
        ? { authoredCommand: command }
        : {}),
      ...(program !== command
        ? { selectedExecutable: args.managedAgentCommands?.[args.agent] }
        : {}),
      ...(keptTokens.length !== rawTokens.length ||
      keptTokens.some((token, index) => token !== rawTokens[index]) ||
      resolvedOptions.permissionArgs ||
      resumeOptionArgs.length > 0
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

/** Resolve authored defaults against the original raw text before compiling either into argv. */
export function terminalSessionOptionInputs(args: {
  agent: TuiAgent
  settings?: AgentLaunchProfileSettings | null
  sessionOptions: Readonly<Record<string, SessionOptionValue>> | undefined
  yieldToAgentArgs?: boolean
  agentArgs: string | null | undefined
  shell: AgentStartupShell
  command?: string
  extraAgentArgs?: string
}): {
  agentArgs?: string | null
  sessionOptions?: Record<string, SessionOptionValue>
  sessionOptionsOverrideAgentArgs?: true
} {
  const permission = readLaunchPermissionChoice(args.sessionOptions)
  let raw =
    args.agentArgs === undefined
      ? resolveTuiAgentLaunchRawArgs(
          args.agent,
          args.settings,
          permission ? 'own' : undefined,
          args.shell
        )
      : args.agentArgs
  const extras = hasExtraAgentArgs(args.extraAgentArgs)
    ? parseExtraAgentArgs({ agent: args.agent, extraAgentArgs: args.extraAgentArgs })
    : undefined
  if (extras && !extras.ok) {
    throw new Error(extras.error)
  }
  if (extras?.ok) {
    const merged = mergeParsedExtraAgentArgs({
      agent: args.agent,
      defaultArgs: raw,
      extras,
      shell: args.shell
    })
    if (!merged.ok) {
      throw new Error(merged.error)
    }
    raw = merged.agentArgs
  }
  const authored = args.settings?.agentLaunchChoices?.[args.agent]
  let defaultValues = {
    ...authored?.options,
    ...(authored?.model ? { model: authored.model } : {})
  }
  if (Object.keys(defaultValues).length) {
    const command = tokenizeStartupCommand(args.command ?? '', args.shell)
    defaultValues = yieldAgentChoicesToArgs(args.agent, defaultValues, [
      ...(command.ok ? command.tokens : []),
      ...(extras?.ok ? extras.tokens : [])
    ])
  }
  const { model: defaultModel, ...defaultOptions } = defaultValues
  const choices = resolveAgentChoiceLayers({
    agent: args.agent,
    defaults: { ...(defaultModel ? { model: defaultModel } : {}), options: defaultOptions },
    action: args.sessionOptions
      ? {
          ...(typeof args.sessionOptions.model === 'string'
            ? { model: args.sessionOptions.model }
            : {}),
          options: Object.fromEntries(
            Object.entries(args.sessionOptions)
              .filter(([id]) => !['model', 'mode', 'permissionMode'].includes(id))
              .map(([id, value]) => [id, String(value)])
          ),
          ...(permission ? { permissionMode: permission } : {})
        }
      : undefined,
    argumentOwner: args.agentArgs === undefined ? 'defaults' : 'launch',
    userArgs: raw,
    launchPreferencesYieldToAgentArgs: args.yieldToAgentArgs,
    shell: args.shell
  })
  const sessionOptions = {
    ...choices.options,
    ...(choices.model ? { model: choices.model } : {}),
    ...(choices.permissionMode ? { permissionMode: choices.permissionMode } : {})
  }
  return {
    agentArgs: raw,
    ...(Object.keys(sessionOptions).length > 0
      ? { sessionOptions, sessionOptionsOverrideAgentArgs: true as const }
      : {})
  }
}
