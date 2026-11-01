import type { CommitMessageAgentSpec } from './commit-message-agent-spec'
import { findOptionOccurrence } from './command-option-occurrence'
import { agentRequiredValueOptions } from './agent-session-option-agent-args'
import { KIMI_VALUE_OPTIONS } from './commit-message-generation-options'
import {
  tokenizeCustomCommandTemplate,
  type CommandTemplateBackslash
} from './commit-message-prompt'

/** Remove only proven flag spans so unrelated arguments retain their spelling and quoting. */
export function removeSourceControlAiArgumentFlag(
  agentArgs: string,
  spec: CommitMessageAgentSpec,
  field: 'model' | 'effort',
  backslash: CommandTemplateBackslash = 'escape'
): { agentArgs: string; unrecognized: boolean } {
  const parsed = tokenizeCustomCommandTemplate(agentArgs, backslash)
  if (!parsed.ok) {
    return { agentArgs, unrecognized: true }
  }
  const removals = new Map<number, number>()
  let unrecognized = false
  const valueOptions = [
    ...agentRequiredValueOptions(spec.id),
    ...(spec.id === 'kimi' ? KIMI_VALUE_OPTIONS : []),
    ...spec.modelFlag.flatMap((flag) => flag.aliases),
    ...spec.effortFlag.flatMap((flag) => flag.aliases)
  ]
  for (const flag of field === 'model' ? spec.modelFlag : spec.effortFlag) {
    let cursor = 0
    let found = findOptionOccurrence(parsed.tokens, flag.aliases, true, valueOptions, cursor)
    while (found) {
      const end = found.index + found.consumed
      const value = found.value
      const separator = value?.indexOf('=') ?? -1
      const matchesKey = !flag.configKey || value?.slice(0, separator).trim() === flag.configKey
      const malformedKey = flag.configKey && value?.trim() === flag.configKey
      if (matchesKey || malformedKey || value === undefined) {
        if (
          !value ||
          malformedKey ||
          (flag.configKey && !value.slice(separator + 1).trim()) ||
          parsed.spans.slice(found.index, end).some((span) => span.divergesFromShell)
        ) {
          unrecognized = true
        } else {
          // A variant shares the model operand; the writer saves the effective model alongside effort.
          removals.set(parsed.spans[found.index].start, parsed.spans[end - 1].end)
        }
      }
      cursor = end
      found = findOptionOccurrence(parsed.tokens, flag.aliases, true, valueOptions, cursor)
    }
  }
  let text = agentArgs
  for (const [start, end] of [...removals].sort(([a], [b]) => b - a)) {
    text = text.slice(0, start) + text.slice(end)
  }
  return { agentArgs: removals.size ? text.trim() : agentArgs, unrecognized }
}
