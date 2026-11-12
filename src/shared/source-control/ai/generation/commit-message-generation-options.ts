import { generationOptionTokens, type GenerationArgument } from './generation-argument'
import { findOptionOccurrence } from '../../../command-option-occurrence'
import {
  tokenizeCustomCommandTemplate,
  type CommandTemplateBackslash
} from './commit-message-prompt'

export function planAdditionalAgentArgs(
  agentArgs: string | null | undefined,
  backslash: CommandTemplateBackslash = 'escape'
): { ok: true; args: string[] } | { ok: false; error: string } {
  const trimmed = agentArgs?.trim()
  if (!trimmed) {
    return { ok: true, args: [] }
  }
  const tokenized = tokenizeCustomCommandTemplate(trimmed, backslash)
  if (!tokenized.ok) {
    return { ok: false, error: `CLI arguments are invalid: ${tokenized.error}` }
  }
  return { ok: true, args: tokenized.tokens }
}

export const KIMI_VALUE_OPTIONS = [
  '--prompt',
  '-p',
  '--model',
  '-m',
  '--output-format',
  '--skills-dir',
  '--agent',
  '--agent-file',
  '--add-dir'
]

export function findRecipeOption(
  tokens: readonly GenerationArgument[],
  aliases: readonly string[],
  valueOptions: readonly string[],
  startIndex = 0,
  stopAtTerminator = true
) {
  return findOptionOccurrence(
    generationOptionTokens(tokens),
    aliases,
    stopAtTerminator,
    valueOptions,
    startIndex,
    valueOptions.length ? 'required' : true
  )
}

export function compactRecipeOptions<T extends GenerationArgument>(
  tokens: T[],
  aliases: readonly string[],
  valueOptions: readonly string[] = [],
  keepFirst = false
): T[] {
  const result: T[] = []
  let cursor = 0
  let kept = false
  let found = findRecipeOption(tokens, aliases, valueOptions, cursor)
  while (found) {
    const end = found.index + found.consumed
    const keepUntil = keepFirst && !kept ? end : found.index
    for (; cursor < keepUntil; cursor++) {
      result.push(tokens[cursor])
    }
    cursor = end
    kept = true
    found = findRecipeOption(tokens, aliases, valueOptions, cursor)
  }
  for (; cursor < tokens.length; cursor++) {
    result.push(tokens[cursor])
  }
  return result
}
