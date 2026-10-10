// What a chat runs when the account's current model list no longer offers its selected model.
// Shared by the host (at rest and at start) and the picker, so both move to the same model.

import type { AgentSessionOptionCatalog } from './agent-session-option-catalog'
import {
  cloneNativeChatSessionOptionRecord,
  type NativeChatSessionOptionRecord
} from './native-chat-session-option-state'

type ListedModelIdentity = { id: string; isDefault?: boolean; resolvedModel?: string | null }

/** Whether `models` names `selected`, as an id or as the provider id a listed alias runs. The one
 *  "is this model listed" rule, for every agent and every caller. */
export function agentModelListNames(
  models: readonly ListedModelIdentity[],
  selected: string
): boolean {
  return listedAgentModelId(models, selected) !== undefined
}

/** The id of the row naming `selected`: an exact id first, else the alias that runs it. */
export function listedAgentModelId(
  models: readonly ListedModelIdentity[],
  selected: string
): string | undefined {
  return (
    models.find((model) => model.id === selected) ??
    models.find((model) => model.resolvedModel === selected)
  )?.id
}

/** What a selection the list no longer offers gives way to: the list's default, else its first. */
export function agentModelListReplacement(models: readonly ListedModelIdentity[]): string | null {
  return (models.find((model) => model.isDefault === true) ?? models[0])?.id ?? null
}

/** `replacement` when `models` lacks `selected`; null keeps the selection. */
export function unlistedAgentModelReplacement(
  models: readonly ListedModelIdentity[],
  selected: string | null | undefined,
  replacement: string | undefined
): string | null {
  return selected && replacement && !agentModelListNames(models, selected) ? replacement : null
}

const EFFORT_RANK = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']

/** `previous` carried to a model offering `supported`: kept when offered, else the nearest offered
 *  level (the higher on a tie); none when it is unranked or the model offers no levels. */
export function nearestAgentEffort(
  previous: string | undefined,
  supported: readonly string[]
): string | undefined {
  if (!previous || supported.includes(previous)) {
    return previous
  }
  const rank = EFFORT_RANK.indexOf(previous)
  let best: { level: string; distance: number; rank: number } | undefined
  for (const level of supported) {
    const levelRank = EFFORT_RANK.indexOf(level)
    if (rank === -1 || levelRank === -1) {
      continue
    }
    const distance = Math.abs(levelRank - rank)
    if (
      !best ||
      distance < best.distance ||
      (distance === best.distance && levelRank > best.rank)
    ) {
      best = { level, distance, rank: levelRank }
    }
  }
  return best?.level
}

/** `record` with a selection the current `catalog` lacks moved to the host's `replacement`, shown
 *  as a `default`, its effort carried to the nearest level that model offers; `record` otherwise,
 *  and always while the host names no replacement (its list unverified). */
export function verifiedListReplacementRecord(
  catalog: AgentSessionOptionCatalog,
  record: NativeChatSessionOptionRecord,
  replacement: string | undefined
): NativeChatSessionOptionRecord {
  const selected = typeof record.model?.value === 'string' ? record.model.value : null
  const target = unlistedAgentModelReplacement(catalog.models, selected, replacement)
  if (!selected || !target) {
    return record
  }
  const next = cloneNativeChatSessionOptionRecord(record)
  next.model = { value: target, source: 'default' }
  const effort = next.valuesByModel[selected]?.effort
  const effortOption = catalog.models
    .find((model) => model.id === target)
    ?.options.find((option) => option.id === 'effort')
  const carried = nearestAgentEffort(
    typeof effort?.value === 'string' ? effort.value : undefined,
    effortOption?.kind.type === 'select'
      ? effortOption.kind.choices.map((choice) => choice.value)
      : []
  )
  if (effort && carried) {
    next.valuesByModel[target] = {
      ...next.valuesByModel[target],
      effort: { ...effort, value: carried }
    }
  }
  return next
}
