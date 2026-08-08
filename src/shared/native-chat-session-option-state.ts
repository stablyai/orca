import type { AgentType } from './agent-status-types'
import type {
  CatalogMidSessionApply,
  AgentSessionOptionCatalog
} from './agent-session-option-catalog'
import type { SessionOptionValue, SessionOptionValueSource } from './native-chat-session-options'

export type TrackedNativeChatSessionOption = {
  value: SessionOptionValue
  source: Exclude<SessionOptionValueSource, 'unknown'>
}

export type NativeChatSessionOptionRecord = {
  agent: AgentType
  model?: TrackedNativeChatSessionOption
  valuesByModel: Record<string, Record<string, TrackedNativeChatSessionOption>>
}

export function createNativeChatSessionOptionRecord(
  agent: AgentType
): NativeChatSessionOptionRecord {
  return { agent, valuesByModel: {} }
}

export function cloneNativeChatSessionOptionRecord(
  record: NativeChatSessionOptionRecord
): NativeChatSessionOptionRecord {
  return {
    agent: record.agent,
    ...(record.model ? { model: { ...record.model } } : {}),
    valuesByModel: Object.fromEntries(
      Object.entries(record.valuesByModel).map(([modelId, values]) => [
        modelId,
        Object.fromEntries(Object.entries(values).map(([id, tracked]) => [id, { ...tracked }]))
      ])
    )
  }
}

export function isFlipOnlyMidSession(
  midSession: CatalogMidSessionApply | undefined
): midSession is Extract<CatalogMidSessionApply, { kind: 'toggle-command' }> {
  return midSession?.kind === 'toggle-command'
}

export function getTrackedSessionOption(
  record: NativeChatSessionOptionRecord,
  modelId: string | null,
  optionId: string
): TrackedNativeChatSessionOption | undefined {
  return modelId ? record.valuesByModel[modelId]?.[optionId] : undefined
}

export function clearTrackedSessionOption(
  record: NativeChatSessionOptionRecord,
  modelId: string | null,
  optionId: string
): void {
  if (!modelId) {
    return
  }
  const current = record.valuesByModel[modelId]
  if (!current || !(optionId in current)) {
    return
  }
  const next = { ...current }
  delete next[optionId]
  if (Object.keys(next).length === 0) {
    delete record.valuesByModel[modelId]
  } else {
    record.valuesByModel[modelId] = next
  }
}

export function clearNativeChatSessionModel(record: NativeChatSessionOptionRecord): void {
  const modelId = typeof record.model?.value === 'string' ? record.model.value : null
  record.model = undefined
  if (modelId) {
    delete record.valuesByModel[modelId]
  }
}

export function setTrackedSessionOption(
  record: NativeChatSessionOptionRecord,
  optionId: string,
  value: SessionOptionValue,
  source: TrackedNativeChatSessionOption['source'],
  /** The model the picker drew this option under when none is tracked — without it a
   *  value set against a CLI default would be dispatched and then silently forgotten. */
  fallbackModelId: string | null = null
): string | null {
  if (optionId === 'model') {
    record.model = { value, source }
    return typeof value === 'string' ? value : null
  }
  const modelId =
    (typeof record.model?.value === 'string' ? record.model.value : null) ?? fallbackModelId
  if (!modelId) {
    return null
  }
  record.valuesByModel[modelId] = {
    ...record.valuesByModel[modelId],
    [optionId]: { value, source }
  }
  return modelId
}

export function flattenNativeChatSessionOptionRecord(
  record: NativeChatSessionOptionRecord,
  modelId: string
): Record<string, SessionOptionValue> {
  return {
    model: modelId,
    ...Object.fromEntries(
      Object.entries(record.valuesByModel[modelId] ?? {}).map(([id, tracked]) => [
        id,
        tracked.value
      ])
    )
  }
}

export function applyNativeChatReportedSessionOptions(
  record: NativeChatSessionOptionRecord,
  values: Record<string, SessionOptionValue>
): boolean {
  const modelId = typeof values.model === 'string' ? values.model : null
  if (!modelId) {
    return false
  }
  const modelChanged = record.model?.value !== modelId
  let changed = modelChanged || record.model?.source !== 'reported'
  record.model = { value: modelId, source: 'reported' }
  const modelValues = modelChanged ? {} : { ...record.valuesByModel[modelId] }
  for (const [id, value] of Object.entries(values)) {
    if (id === 'model') {
      continue
    }
    const current = modelValues[id]
    if (current?.value !== value || current.source !== 'reported') {
      changed = true
    }
    modelValues[id] = { value, source: 'reported' }
  }
  record.valuesByModel[modelId] = modelValues
  return changed
}

export function matchNativeChatCatalogModelId(
  catalog: AgentSessionOptionCatalog,
  reported: string
): string | null {
  const normalized = reported.trim().toLowerCase()
  if (!normalized) {
    return null
  }
  const exact = catalog.models.find((model) => model.id.toLowerCase() === normalized)
  if (exact) {
    return exact.id
  }
  const byLabel = catalog.models.find((model) => model.label.toLowerCase() === normalized)
  if (byLabel) {
    return byLabel.id
  }
  const containing = [...catalog.models]
    .sort((left, right) => right.id.length - left.id.length)
    .find((model) => normalized.includes(model.id.toLowerCase()))
  return containing?.id ?? null
}
