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

// Why an allowlist: extras come from any paired client, so they must not reach the host's
// permission posture or flags Orca owns (prompt, resume, cwd, print mode, config, MCP).
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
      const separator = option.kind === 'repeatable' ? '=' : ' '
      return `${option.aliases[0]}${separator}${option.valuePrefix ?? ''}${value}`
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

export type ParsedExtraAgentArgs =
  | { ok: true; tokens: string[]; kinds: ReadonlySet<ExtraAgentArgKind> }
  | { ok: false; error: string }

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
    return { ok: false, error: `Extra arguments aren't supported for this agent yet.` }
  }
  if (new TextEncoder().encode(args.extraAgentArgs).length > EXTRA_AGENT_ARGS_MAX_BYTES) {
    return { ok: false, error: 'Extra arguments must be 4 KB or less.' }
  }
  if (hasControlCharacter(args.extraAgentArgs)) {
    return { ok: false, error: 'Extra arguments cannot contain control characters or line breaks.' }
  }
  const text = args.extraAgentArgs.trim()
  const tokenized = tokenizeStartupCommand(text, 'posix')
  if (!tokenized.ok) {
    return { ok: false, error: `Extra arguments are invalid: ${tokenized.error}` }
  }
  // Reject command syntax instead of silently turning it into literal argument text.
  const divergent = tokenized.spans.find((span) => span.divergesFromShell)
  if (divergent) {
    return {
      ok: false,
      error: `${text.slice(divergent.start, divergent.end)} uses shell syntax that extra arguments don't allow.`
    }
  }
  const label = TUI_AGENT_DISPLAY_NAMES[args.agent]
  const allowed = allowedOptionList(options)
  const kinds = new Set<ExtraAgentArgKind>()
  const { tokens } = tokenized
  const normalizedTokens: string[] = []
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token === '--') {
      return { ok: false, error: `"--" isn't allowed in extra arguments.` }
    }
    if (!token.startsWith('-')) {
      return {
        ok: false,
        error: `"${token}" isn't an option. Extra arguments for ${label} accept only: ${allowed}.`
      }
    }
    const match = matchOption(tokens.slice(index, index + 2), options)
    if (!match) {
      return {
        ok: false,
        error: `"${optionName(token)}" isn't allowed in extra arguments for ${label}. Allowed: ${allowed}.`
      }
    }
    const name = optionName(token)
    const { value } = match
    if (!value) {
      return { ok: false, error: `"${name}" needs a value.` }
    }
    const { kind, valuePrefix } = match.option
    if (valuePrefix && (!value.startsWith(valuePrefix) || value.length === valuePrefix.length)) {
      return {
        ok: false,
        error: `"${name} ${value}" isn't allowed. ${label} extra arguments accept only "${name} ${valuePrefix}<level>".`
      }
    }
    if (kind !== 'repeatable' && kinds.has(kind)) {
      return { ok: false, error: `Extra arguments set the ${kind} more than once.` }
    }
    kinds.add(kind)
    // Claude's variadic --add-dir would otherwise consume the positional prompt.
    normalizedTokens.push(
      ...(kind === 'repeatable'
        ? [`${name}=${value}`]
        : tokens.slice(index, index + match.consumed))
    )
    index += match.consumed - 1
  }
  return { ok: true, tokens: normalizedTokens, kinds }
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

/**
 * Combines the host's default Arguments with an automation's saved extras into one
 * Arguments string: defaults that extras replace are removed, then extras are appended.
 */
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
