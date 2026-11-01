import type { CommitMessageAgentSpec } from './commit-message-agent-spec'
import { findOptionOccurrence } from './command-option-occurrence'
import { agentRequiredValueOptions } from './agent-session-option-agent-args'
import { KIMI_VALUE_OPTIONS } from './commit-message-generation-options'
import {
  tokenizeCustomCommandTemplate,
  type CommandTemplateBackslash
} from './commit-message-prompt'

type ProvenFlagSpans =
  | { ok: false }
  | {
      ok: true
      removals: Map<number, number>
      unrecognized: boolean
      /** The last proven value token: the one the CLI applies. */
      applied?: { start: number; end: number; value: string }
    }

function findProvenFlagSpans(
  agentArgs: string,
  spec: CommitMessageAgentSpec,
  field: 'model' | 'effort',
  backslash: CommandTemplateBackslash
): ProvenFlagSpans {
  const parsed = tokenizeCustomCommandTemplate(agentArgs, backslash)
  if (!parsed.ok) {
    return { ok: false }
  }
  const removals = new Map<number, number>()
  let unrecognized = false
  let applied: { start: number; end: number; value: string } | undefined
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
          applied = { ...parsed.spans[end - 1], value }
        }
      }
      cursor = end
      found = findOptionOccurrence(parsed.tokens, flag.aliases, true, valueOptions, cursor)
    }
  }
  return { ok: true, removals, unrecognized, applied }
}

/** Remove only proven flag spans so unrelated arguments retain their spelling and quoting. */
export function removeSourceControlAiArgumentFlag(
  agentArgs: string,
  spec: CommitMessageAgentSpec,
  field: 'model' | 'effort',
  backslash: CommandTemplateBackslash = 'escape'
): { agentArgs: string; unrecognized: boolean; value?: string } {
  const found = findProvenFlagSpans(agentArgs, spec, field, backslash)
  if (!found.ok) {
    return { agentArgs, unrecognized: true }
  }
  let text = agentArgs
  for (const [start, end] of [...found.removals].sort(([a], [b]) => b - a)) {
    text = text.slice(0, start) + text.slice(end)
  }
  return found.removals.size
    ? { agentArgs: text.trim(), unrecognized: found.unrecognized, value: found.applied?.value }
    : { agentArgs, unrecognized: found.unrecognized }
}

/** Rewrite the applied value in place, keeping its flag spelling and every other argument. */
export function rewriteSourceControlAiArgumentFlagValue(
  agentArgs: string,
  spec: CommitMessageAgentSpec,
  field: 'model' | 'effort',
  rewrite: (value: string) => string,
  backslash: CommandTemplateBackslash = 'escape'
): string {
  const found = findProvenFlagSpans(agentArgs, spec, field, backslash)
  const applied = found.ok ? found.applied : undefined
  if (!applied) {
    return agentArgs
  }
  const raw = agentArgs.slice(applied.start, applied.end)
  const at = raw.lastIndexOf(applied.value)
  if (at === -1) {
    return agentArgs
  }
  return (
    agentArgs.slice(0, applied.start) +
    raw.slice(0, at) +
    rewrite(applied.value) +
    raw.slice(at + applied.value.length) +
    agentArgs.slice(applied.end)
  )
}
