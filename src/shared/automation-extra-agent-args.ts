import { agentArgTerminatorIndex } from './agent-session-option-agent-args'
import { getAgentSessionOptionLaunchCatalog } from './agent-session-option-launch'
import { findOptionOccurrence } from './command-option-occurrence'
import {
  quoteStartupArg,
  tokenizeStartupCommand,
  type AgentStartupShell
} from './tui-agent-startup-shell'
import type { TuiAgent } from './tui-agent'
import { TUI_AGENT_DISPLAY_NAMES } from './tui-agent-display-names'

export const EXTRA_AGENT_ARGS_MAX_BYTES = 4096
export const EXTRA_AGENT_ARGS_HOST_UPDATE_REQUIRED =
  'Update Orca on this host to use extra arguments.'
export const EXTRA_AGENT_ARGS_REQUIRE_FRESH_SESSION =
  'Extra arguments require a fresh session for every run.'

type ExtraAgentArgKind = 'model' | 'effort' | 'repeatable'

type ExtraAgentArgOption = {
  kind: ExtraAgentArgKind
  aliases: readonly string[]
  /** Accepts only values with this prefix, e.g. Codex's `-c model_reasoning_effort=`. */
  valuePrefix?: string
}

const MODEL_OPTION = { kind: 'model', aliases: ['--model'] } as const
const MODEL_OR_M_OPTION = { kind: 'model', aliases: ['-m', '--model'] } as const

// Allowlist paired-client extras so they cannot alter permissions or Orca-owned prompt/resume/cwd/print/config/MCP flags.
const EXTRA_AGENT_ARG_OPTIONS: Partial<Record<TuiAgent, readonly ExtraAgentArgOption[]>> = {
  claude: [
    MODEL_OPTION,
    { kind: 'effort', aliases: ['--effort'] },
    { kind: 'repeatable', aliases: ['--add-dir'] }
  ],
  codex: [
    MODEL_OR_M_OPTION,
    { kind: 'effort', aliases: ['-c', '--config'], valuePrefix: 'model_reasoning_effort=' }
  ],
  codebuddy: [MODEL_OPTION, { kind: 'effort', aliases: ['--effort'] }],
  // Cursor composes effort into the model id, so only the model is a flag.
  cursor: [MODEL_OR_M_OPTION],
  grok: [MODEL_OR_M_OPTION, { kind: 'effort', aliases: ['--effort', '--reasoning-effort'] }],
  omp: [MODEL_OPTION]
}

export function supportsExtraAgentArgs(agent: TuiAgent): boolean {
  return EXTRA_AGENT_ARG_OPTIONS[agent] !== undefined
}

export function getExtraAgentArgsPlaceholder(agent: TuiAgent): string {
  return (EXTRA_AGENT_ARG_OPTIONS[agent] ?? [])
    .map((option) => {
      const value =
        option.kind === 'model'
          ? agent === 'claude'
            ? 'opus'
            : 'model-id'
          : option.kind === 'effort'
            ? 'high'
            : 'docs'
      return `${option.aliases[0]} ${option.valuePrefix ?? ''}${value}`
    })
    .join(' ')
}

// C0, DEL, C1, and the Unicode line/paragraph separators.
function hasControlCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029) {
      return true
    }
  }
  return false
}

// One English table: `error` stays English for older readers; the renderer translates by code.
export const EXTRA_AGENT_ARGS_FAILURE_COPY = {
  unsupportedAgent: "Extra arguments aren't supported for this agent yet.",
  tooLarge: 'Extra arguments must be 4 KB or less.',
  controlCharacters: 'Extra arguments cannot contain control characters or line breaks.',
  invalid: 'Extra arguments are invalid: {{detail}}',
  shellSyntax: "{{text}} uses shell syntax that extra arguments don't allow.",
  terminator: '"--" isn\'t allowed in extra arguments.',
  notAnOption:
    '"{{token}}" isn\'t an option. Extra arguments for {{agent}} accept only: {{allowed}}.',
  optionNotAllowed:
    '"{{option}}" isn\'t allowed in extra arguments for {{agent}}. Allowed: {{allowed}}.',
  missingValue: '"{{option}}" needs a value.',
  valueNotAllowed:
    '"{{option}} {{value}}" isn\'t allowed. {{agent}} extra arguments accept only "{{option}} {{prefix}}<level>".',
  modelRepeated: 'Extra arguments set the model more than once.',
  effortRepeated: 'Extra arguments set the effort more than once.'
} as const

export type ExtraAgentArgsFailureCode = keyof typeof EXTRA_AGENT_ARGS_FAILURE_COPY

export type ExtraAgentArgsFailure = {
  ok: false
  error: string
  errorCode: ExtraAgentArgsFailureCode
  errorParams?: Record<string, string>
}

function extraAgentArgsFailure(
  errorCode: ExtraAgentArgsFailureCode,
  params?: Record<string, string>
): ExtraAgentArgsFailure {
  // One pass so a value containing "{{x}}" stays verbatim.
  const error = EXTRA_AGENT_ARGS_FAILURE_COPY[errorCode].replace(
    /\{\{(\w+)\}\}/g,
    (slot, name: string) => params?.[name] ?? slot
  )
  return { ok: false, error, errorCode, ...(params ? { errorParams: params } : {}) }
}

export type ParsedExtraAgentArgs =
  | { ok: true; tokens: string[]; kinds: ReadonlySet<ExtraAgentArgKind> }
  | ExtraAgentArgsFailure

export type MergedAgentArgs = { ok: true; agentArgs: string } | { ok: false; error: string }

/** Saved extras as the launch sees them; whitespace-only text means none. */
export function hasExtraAgentArgs(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function allowedOptionList(options: readonly ExtraAgentArgOption[]): string {
  return [
    ...new Set(
      options.map((option) =>
        option.valuePrefix ? `${option.aliases[0]} ${option.valuePrefix}…` : option.aliases.at(-1)
      )
    )
  ].join(', ')
}

function matchOption(
  tokens: readonly string[],
  options: readonly ExtraAgentArgOption[]
): { option: ExtraAgentArgOption; value?: string; consumed: number } | null {
  for (const option of options) {
    const occurrence = findOptionOccurrence(tokens, option.aliases, false)
    if (occurrence?.index === 0) {
      return { option, value: occurrence.value, consumed: occurrence.consumed }
    }
  }
  return null
}

function optionName(token: string): string {
  const equals = token.indexOf('=')
  return equals > 0 ? token.slice(0, equals) : token
}

/** Saved extras use one quoting grammar, independent of the client and execution host. */
export function parseExtraAgentArgs(args: {
  agent: TuiAgent
  extraAgentArgs: string
}): ParsedExtraAgentArgs {
  const options = EXTRA_AGENT_ARG_OPTIONS[args.agent]
  if (!options) {
    return extraAgentArgsFailure('unsupportedAgent')
  }
  if (new TextEncoder().encode(args.extraAgentArgs).length > EXTRA_AGENT_ARGS_MAX_BYTES) {
    return extraAgentArgsFailure('tooLarge')
  }
  if (hasControlCharacter(args.extraAgentArgs)) {
    return extraAgentArgsFailure('controlCharacters')
  }
  const text = args.extraAgentArgs.trim()
  const tokenized = tokenizeStartupCommand(text, 'posix')
  if (!tokenized.ok) {
    return extraAgentArgsFailure('invalid', { detail: tokenized.error })
  }
  // Reject command syntax instead of silently turning it into literal argument text.
  const divergent = tokenized.spans.find((span) => span.divergesFromShell)
  if (divergent) {
    return extraAgentArgsFailure('shellSyntax', {
      text: text.slice(divergent.start, divergent.end)
    })
  }
  const label = TUI_AGENT_DISPLAY_NAMES[args.agent]
  const allowed = allowedOptionList(options)
  const kinds = new Set<ExtraAgentArgKind>()
  const { tokens } = tokenized
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token === '--') {
      return extraAgentArgsFailure('terminator')
    }
    if (!token.startsWith('-')) {
      return extraAgentArgsFailure('notAnOption', { token, agent: label, allowed })
    }
    const match = matchOption(tokens.slice(index, index + 2), options)
    if (!match) {
      return extraAgentArgsFailure('optionNotAllowed', {
        option: optionName(token),
        agent: label,
        allowed
      })
    }
    const name = optionName(token)
    const { value } = match
    if (!value) {
      return extraAgentArgsFailure('missingValue', { option: name })
    }
    const { kind, valuePrefix } = match.option
    if (valuePrefix && (!value.startsWith(valuePrefix) || value.length === valuePrefix.length)) {
      return extraAgentArgsFailure('valueNotAllowed', {
        option: name,
        value,
        agent: label,
        prefix: valuePrefix
      })
    }
    if (kind !== 'repeatable' && kinds.has(kind)) {
      return extraAgentArgsFailure(kind === 'model' ? 'modelRepeated' : 'effortRepeated')
    }
    kinds.add(kind)
    index += match.consumed - 1
  }
  return { ok: true, tokens, kinds }
}

function removeDefaultsFor(
  agent: TuiAgent,
  kinds: ReadonlySet<ExtraAgentArgKind>,
  tokens: readonly string[]
): string[] {
  const catalog = getAgentSessionOptionLaunchCatalog(agent)
  let result = [...tokens]
  if (!catalog) {
    return result
  }
  if (kinds.has('model')) {
    result = catalog.modelApply.removeAgentArgs?.(result) ?? result
  }
  if (kinds.has('effort')) {
    const effort = [
      ...(catalog.unknownModelOptions ?? []),
      ...catalog.models.flatMap((model) => model.options)
    ].find((option) => option.id === 'effort' && option.apply.removeAgentArgs)
    result = effort?.apply.removeAgentArgs?.(result) ?? result
  }
  return result
}

/** Remove defaults overridden by saved extras before appending them to one launch Arguments string. */
export function mergeExtraAgentArgs(args: {
  agent: TuiAgent
  defaultArgs: string | null | undefined
  extraAgentArgs: string | undefined
  shell: AgentStartupShell
}): MergedAgentArgs {
  const defaultArgs = args.defaultArgs ?? ''
  if (!hasExtraAgentArgs(args.extraAgentArgs)) {
    return { ok: true, agentArgs: defaultArgs }
  }
  const extras = parseExtraAgentArgs({
    agent: args.agent,
    extraAgentArgs: args.extraAgentArgs
  })
  if (!extras.ok) {
    return extras
  }
  return mergeParsedExtraAgentArgs({ ...args, defaultArgs, extras })
}

/** Accepted saved POSIX tokens keep their meaning when rendered for the execution shell. */
export function mergeParsedExtraAgentArgs(args: {
  agent: TuiAgent
  defaultArgs: string | null | undefined
  extras: Extract<ParsedExtraAgentArgs, { ok: true }>
  shell: AgentStartupShell
}): MergedAgentArgs {
  const defaultArgs = args.defaultArgs ?? ''
  const { extras } = args
  const defaults = defaultArgs.trim()
    ? tokenizeStartupCommand(defaultArgs.trim(), args.shell)
    : { ok: true as const, tokens: [] }
  if (!defaults.ok) {
    return { ok: false, error: `Default agent arguments are invalid: ${defaults.error}` }
  }
  const kept = removeDefaultsFor(args.agent, extras.kinds, defaults.tokens)
  const terminator = agentArgTerminatorIndex(args.agent, kept)
  const merged = [...kept.slice(0, terminator), ...extras.tokens, ...kept.slice(terminator)]
  const agentArgs = merged.map((token) => quoteStartupArg(token, args.shell)).join(' ')
  // Why: the launch re-tokenizes this string; refuse rather than launch different argv.
  const reparsed = tokenizeStartupCommand(agentArgs, args.shell)
  if (
    !reparsed.ok ||
    reparsed.tokens.length !== merged.length ||
    reparsed.tokens.some((token, index) => token !== merged[index])
  ) {
    return {
      ok: false,
      error: "This host's default agent arguments can't be combined with extra arguments."
    }
  }
  return { ok: true, agentArgs }
}
