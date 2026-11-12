import {
  analyzeAgentChoiceWords,
  optionName,
  type permissionOptionInventory
} from '../permissions/agent-permission-args'
import { tokenizeStartupCommand, type AgentStartupShell } from '../startup/tui-agent-startup-shell'
import type { TuiAgent } from '../catalog/tui-agent'
import type { ChoiceOccurrence } from './agent-launch-choices'

type ParsedArguments = Extract<ReturnType<typeof tokenizeStartupCommand>, { ok: true }>

export function cutAgentChoiceArgs(input: {
  agent: TuiAgent
  text: string
  grammars: readonly AgentStartupShell[]
  originals: readonly ({
    parsed: ParsedArguments
    analysis: ReturnType<typeof analyzeAgentChoiceWords>
  } | null)[]
  occurrences: readonly ChoiceOccurrence[]
  inventory: ReturnType<typeof permissionOptionInventory>
  selected: readonly Pick<ChoiceOccurrence, 'start' | 'end' | 'replacement'>[]
  purpose?: 'delete'
}): string | null {
  const { agent, text, grammars, originals, occurrences, inventory, selected, purpose } = input
  const first = originals[0]

  if (!first || !selected.length) {
    return selected.length ? null : text
  }
  const ranges = [...selected].sort((a, b) => a.start - b.start)
  if (ranges.some((range, index) => index > 0 && range.start < ranges[index - 1].end)) {
    return null
  }
  const subtraction =
    purpose === 'delete' && ranges.every((range) => range.replacement === undefined)
  if (
    subtraction &&
    ranges.some(
      (range) =>
        !occurrences.some(
          (entry) => entry.source && entry.start === range.start && entry.end === range.end
        )
    )
  ) {
    return null
  }
  const replacements = new Map(
    ranges.filter((range) => range.replacement).map((range) => [range.start, range.replacement])
  )
  const chunks: string[] = []
  let cursor = 0
  for (const { start, end, replacement } of ranges) {
    chunks.push(text.slice(cursor, start), replacement ?? '')
    cursor = end
  }
  chunks.push(text.slice(cursor))
  const args = subtraction ? chunks.join('') : chunks.join('').trim()
  const proven = originals.every((original, grammarIndex) => {
    if (!original) {
      return false
    }
    // CLI ownership does not establish shell expansion or command boundaries.
    if (subtraction && original.parsed.spans.some((span) => span.divergesFromShell)) {
      return false
    }
    let rangeIndex = 0
    const removed = original.parsed.spans.map((span) => {
      while (rangeIndex < ranges.length && ranges[rangeIndex].end <= span.start) {
        rangeIndex++
      }
      const range = ranges[rangeIndex]
      return !!range && span.start >= range.start && span.end <= range.end
    })
    const kept = original.parsed.tokens.filter((_, index) => !removed[index])
    const expected = original.parsed.tokens.flatMap((token, index) => {
      if (!removed[index]) {
        return [token]
      }
      const text = replacements.get(original.parsed.spans[index].start)
      if (!text) {
        return []
      }
      const replacement = tokenizeStartupCommand(text, grammars[grammarIndex])
      return replacement.ok ? replacement.tokens : []
    })
    const parsed = tokenizeStartupCommand(args, grammars[grammarIndex])
    if (
      !parsed.ok ||
      expected.length !== parsed.tokens.length ||
      !expected.every((token, index) => token === parsed.tokens[index])
    ) {
      return false
    }
    if (subtraction) {
      return preservesDeletedChoiceArgumentRoles({
        agent,
        tokens: original.parsed.tokens,
        roles: original.analysis.roles,
        optionIndices: original.analysis.optionIndices,
        removed,
        retained: parsed.tokens,
        inventory
      })
    }
    const prefix = original.parsed.tokens.filter((_, index) => removed[index])
    const composed = analyzeAgentChoiceWords(agent, [...prefix, ...kept], inventory)
    const roles = original.analysis.roles.filter((_, index) => !removed[index])
    const leading = removed.slice(0, removed.lastIndexOf(true) + 1).every(Boolean)
    return (
      leading ||
      (!original.analysis.roles.includes('uncertain') &&
        roles.every((role, index) => role === composed.roles[prefix.length + index]))
    )
  })
  return proven ? args : null
}

/** Subtraction must preserve retained ownership; it never lifts tokens across an opaque suffix. */
function preservesDeletedChoiceArgumentRoles(args: {
  agent: TuiAgent
  tokens: readonly string[]
  roles: readonly string[]
  optionIndices: ReadonlySet<number>
  removed: readonly boolean[]
  retained: string[]
  inventory: ReturnType<typeof permissionOptionInventory>
}): boolean {
  const { agent, tokens, roles, optionIndices, removed, retained, inventory } = args
  const uncertain = roles.indexOf('uncertain')
  const lastCut = removed.lastIndexOf(true)
  if (removed.some((cut, index) => cut && uncertain !== -1 && index >= uncertain)) {
    return false
  }
  if (
    tokens.some((token, index) => {
      if (index > lastCut || removed[index] || !optionIndices.has(index)) {
        return false
      }
      const name = optionName(agent, token)
      return token === name && inventory.values.has(name) && roles[index + 1] !== `value:${name}`
    })
  ) {
    return false
  }
  const next = analyzeAgentChoiceWords(agent, retained, inventory)
  return roles
    .filter((_, index) => !removed[index])
    .every((role, index) => role === next.roles[index])
}
