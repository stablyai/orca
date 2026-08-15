import type { AgentType } from './agent-status-types'
import {
  getAgentSessionOptionCatalog,
  type AgentSessionOptionCatalog
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
  /** Options that belong to the session, not to the selected model. */
  sessionValues: Record<string, TrackedNativeChatSessionOption>
}

export function createNativeChatSessionOptionRecord(
  agent: AgentType
): NativeChatSessionOptionRecord {
  return { agent, valuesByModel: {}, sessionValues: {} }
}

/** Deep-copies one bucket of tracked values, tolerating a record rehydrated
 *  from a cache written before that bucket existed. */
function cloneTrackedOptionValues(
  values: Record<string, TrackedNativeChatSessionOption> | undefined
): Record<string, TrackedNativeChatSessionOption> {
  // `?? {}`: records rehydrated from a cache written before sessionValues existed.
  return Object.fromEntries(
    Object.entries(values ?? {}).map(([id, tracked]) => [id, { ...tracked }])
  )
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
        cloneTrackedOptionValues(values)
      ])
    ),
    sessionValues: cloneTrackedOptionValues(record.sessionValues)
  }
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
  // Why: a session-scoped option has no model to file under; returning null
  // means "no model id to persist against", which is exactly right for it.
  if (
    getAgentSessionOptionCatalog(record.agent)?.sessionOptions?.some(
      (option) => option.id === optionId
    )
  ) {
    record.sessionValues[optionId] = { value, source }
    return null
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
  const sessionOptionIds = new Set(
    (getAgentSessionOptionCatalog(record.agent)?.sessionOptions ?? []).map((option) => option.id)
  )
  let changed = false
  for (const [id, value] of Object.entries(values)) {
    if (!sessionOptionIds.has(id)) {
      continue
    }
    const current = record.sessionValues[id]
    if (current?.value !== value || current.source !== 'reported') {
      changed = true
    }
    record.sessionValues[id] = { value, source: 'reported' }
  }
  const modelId = typeof values.model === 'string' ? values.model : null
  if (!modelId) {
    // Why: a session option is still truthful without a readable model.
    return changed
  }
  const modelChanged = record.model?.value !== modelId
  changed = changed || modelChanged || record.model?.source !== 'reported'
  record.model = { value: modelId, source: 'reported' }
  const modelValues = modelChanged ? {} : { ...record.valuesByModel[modelId] }
  for (const [id, value] of Object.entries(values)) {
    if (id === 'model' || sessionOptionIds.has(id)) {
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
