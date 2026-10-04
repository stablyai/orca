import { findOptionOccurrence } from './command-option-occurrence'

export function agentArgOptionTokens(tokens: readonly string[]): readonly string[] {
  const terminator = tokens.indexOf('--')
  return terminator === -1 ? tokens : tokens.slice(0, terminator)
}

/** Removes each occurrence before `--`, or only those whose value `matchesValue` accepts. */
export function removeAgentArgOption(
  tokens: readonly string[],
  aliases: readonly string[],
  matchesValue: (value: string | undefined) => boolean = () => true
): string[] {
  const kept: string[] = []
  let rest = tokens
  let found = findOptionOccurrence(rest, aliases, true)
  while (found) {
    const end = found.index + found.consumed
    kept.push(...rest.slice(0, matchesValue(found.value) ? found.index : end))
    rest = rest.slice(end)
    found = findOptionOccurrence(rest, aliases, true)
  }
  return [...kept, ...rest]
}
