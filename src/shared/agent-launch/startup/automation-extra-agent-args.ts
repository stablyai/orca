import {
  agentArgTerminatorIndex,
  removeAgentArgOption
} from '../../agent-session/options/launch/agent-session-option-agent-args'
import { getAgentSessionOptionLaunchCatalog } from '../../agent-session/options/agent-session-option-catalog'
import { findOptionOccurrence } from '../../cli/command-option-occurrence'
import {
  quoteStartupArg,
  tokenizeStartupCommand,
  type AgentStartupShell
} from './tui-agent-startup-shell'
import type { TuiAgent } from '../catalog/tui-agent'
import { TUI_AGENT_DISPLAY_NAMES } from '../catalog/tui-agent-display-names'
import {
  EXTRA_AGENT_ARG_OPTIONS,
  EXTRA_AGENT_ARGS_FAILURE_COPY,
  getExtraAgentArgsPlaceholder,
  supportsExtraAgentArgs,
  type ExtraAgentArgKind,
  type ExtraAgentArgOption,
  type ExtraAgentArgsFailure,
  type ExtraAgentArgsFailureCode
} from './automation-extra-agent-arg-catalog'

export {
  EXTRA_AGENT_ARGS_FAILURE_COPY,
  getExtraAgentArgsPlaceholder,
  supportsExtraAgentArgs,
  type ExtraAgentArgsFailure,
  type ExtraAgentArgsFailureCode
}

export const EXTRA_AGENT_ARGS_MAX_BYTES = 4096
export const EXTRA_AGENT_ARGS_HOST_UPDATE_REQUIRED =
  'Update Orca on this host to use extra arguments.'
export const EXTRA_AGENT_ARGS_REQUIRE_FRESH_SESSION =
  'Extra arguments require a fresh session for every run.'

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
        option.valuePrefix
          ? `${option.aliases[0]} ${option.valuePrefix}\u2026`
          : option.aliases.at(-1)
      )
    )
  ].join(', ')
}

function matchOption(
  tokens: readonly string[],
  options: readonly ExtraAgentArgOption[]
): { option: ExtraAgentArgOption; value?: string; consumed: number } | null {
  for (const option of options) {
    const occurrence = findOptionOccurrence(
      tokens,
      option.aliases,
      false,
      [],
      0,
      option.kind === 'flag' ? false : 'required'
    )
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
  const seenOptions = new Set<ExtraAgentArgOption>()
  const { tokens } = tokenized
  const accepted: string[] = []
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
    const { kind, valuePrefix, values, separateValue } = match.option
    if (kind === 'flag') {
      if (match.value !== undefined || token !== name) {
        return extraAgentArgsFailure('invalid', { detail: `${name} does not take a value` })
      }
      if (seenOptions.has(match.option)) {
        return extraAgentArgsFailure('invalid', { detail: `${name} can only be set once` })
      }
      seenOptions.add(match.option)
      kinds.add(kind)
      accepted.push(token)
      continue
    }
    const { value } = match
    if (!value) {
      return extraAgentArgsFailure('missingValue', { option: name })
    }
    if (values && !values.includes(value)) {
      return extraAgentArgsFailure('invalid', { detail: `${name} accepts ${values.join(', ')}` })
    }
    if (valuePrefix && (!value.startsWith(valuePrefix) || value.length === valuePrefix.length)) {
      return extraAgentArgsFailure('valueNotAllowed', {
        option: name,
        value,
        agent: label,
        prefix: valuePrefix
      })
    }
    if (kind !== 'repeatable' && seenOptions.has(match.option)) {
      return extraAgentArgsFailure(
        kind === 'model' ? 'modelRepeated' : kind === 'effort' ? 'effortRepeated' : 'invalid',
        kind === 'value' ? { detail: `${name} can only be set once` } : undefined
      )
    }
    seenOptions.add(match.option)
    kinds.add(kind)
    accepted.push(...(separateValue ? [name, value] : tokens.slice(index, index + match.consumed)))
    index += match.consumed - 1
  }
  return { ok: true, tokens: accepted, kinds }
}

function removeDefaultsFor(
  agent: TuiAgent,
  extras: Extract<ParsedExtraAgentArgs, { ok: true }>,
  tokens: readonly string[]
): string[] {
  const { kinds } = extras
  const catalog = getAgentSessionOptionLaunchCatalog(agent)
  let result = [...tokens]
  if (!catalog) {
    // Without launch catalog removers, the allowlisted aliases are the overridden defaults.
    for (const option of EXTRA_AGENT_ARG_OPTIONS[agent] ?? []) {
      if (option.kind !== 'repeatable' && kinds.has(option.kind)) {
        result = removeAgentArgOption(
          agent,
          result,
          option.aliases,
          undefined,
          option.kind === 'flag' ? false : 'required'
        )
      }
    }
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
  for (const option of EXTRA_AGENT_ARG_OPTIONS[agent] ?? []) {
    if (option.kind !== 'flag' && option.kind !== 'value') {
      continue
    }
    if (
      extras.tokens.some(
        (token) =>
          option.aliases.includes(token) ||
          (option.kind === 'value' && option.aliases.some((alias) => token.startsWith(`${alias}=`)))
      )
    ) {
      result = removeAgentArgOption(
        agent,
        result,
        option.aliases,
        undefined,
        option.kind === 'flag' ? false : 'required'
      )
    }
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
  const kept = removeDefaultsFor(args.agent, extras, defaults.tokens)
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
