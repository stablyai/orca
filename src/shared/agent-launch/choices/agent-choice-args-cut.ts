import {
  analyzeAgentChoiceWords,
  type permissionOptionInventory
} from '../permissions/agent-permission-args'
import { tokenizeStartupCommand, type AgentStartupShell } from '../startup/tui-agent-startup-shell'
import type { TuiAgent } from '../catalog/tui-agent'
import type { ChoiceOccurrence } from './agent-launch-choices'

export type ChoiceArgGrammarAnalysis = {
  parsed: Extract<ReturnType<typeof tokenizeStartupCommand>, { ok: true }>
  analysis: ReturnType<typeof analyzeAgentChoiceWords>
  offsets: Map<number, number>
}

export function buildChoiceArgsCutter(args: {
  agent: TuiAgent
  text: string
  grammars: readonly AgentStartupShell[]
  originals: readonly (ChoiceArgGrammarAnalysis | null)[]
  inventory: ReturnType<typeof permissionOptionInventory>
}) {
  const { agent, text, grammars, originals, inventory } = args
  const first = originals[0]
  return (
    selected: readonly Pick<ChoiceOccurrence, 'start' | 'end' | 'replacement'>[]
  ): string | null => {
    if (!first || !selected.length) {
      return selected.length ? null : text
    }
    const ranges = [...selected].sort((a, b) => a.start - b.start)
    if (ranges.some((range, index) => index > 0 && range.start < ranges[index - 1].end)) {
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
    const nextArgs = chunks.join('').trim()
    const proven = originals.every((original, grammarIndex) => {
      if (!original) {
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
        const replacementText = replacements.get(original.parsed.spans[index].start)
        if (!replacementText) {
          return []
        }
        const replacement = tokenizeStartupCommand(replacementText, grammars[grammarIndex])
        return replacement.ok ? replacement.tokens : []
      })
      const parsed = tokenizeStartupCommand(nextArgs, grammars[grammarIndex])
      if (
        !parsed.ok ||
        expected.length !== parsed.tokens.length ||
        !expected.every((token, index) => token === parsed.tokens[index])
      ) {
        return false
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
    return proven ? nextArgs : null
  }
}
