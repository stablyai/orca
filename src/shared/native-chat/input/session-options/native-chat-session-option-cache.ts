import type { AgentType } from '../../../agent-status/contracts/agent-status-types'
import type { SessionOptionValue } from '../native-chat-session-options'
import {
  clearTrackedSessionOption,
  cloneNativeChatSessionOptionRecord,
  createNativeChatSessionOptionRecord,
  getTrackedSessionOption,
  setTrackedSessionOption,
  type NativeChatSessionOptionRecord,
  type TrackedNativeChatSessionOption
} from './native-chat-session-option-state'
import { setBoundedScopeCacheEntry } from '../composer/native-chat-scope-cache'

const sessionOptionCache = new Map<string, NativeChatSessionOptionRecord>()

export function readNativeChatSessionOptionCache(
  scopeKey: string,
  fallbackScopeKey?: string
): NativeChatSessionOptionRecord | null {
  const record = sessionOptionCache.get(scopeKey) ?? sessionOptionCache.get(fallbackScopeKey ?? '')
  return record ? cloneNativeChatSessionOptionRecord(record) : null
}

export function writeNativeChatSessionOptionCache(
  scopeKey: string,
  record: NativeChatSessionOptionRecord
): void {
  setBoundedScopeCacheEntry(
    sessionOptionCache,
    scopeKey,
    cloneNativeChatSessionOptionRecord(record)
  )
}

export function seedNativeChatAppliedSessionOptions(
  scopeKey: string,
  agent: AgentType,
  values: Record<string, SessionOptionValue> | null | undefined
): void {
  const modelId = typeof values?.model === 'string' ? values.model : null
  if (!modelId) {
    return
  }
  const record = createNativeChatSessionOptionRecord(agent)
  record.model = { value: modelId, source: 'applied' }
  const modelValues: Record<string, TrackedNativeChatSessionOption> = {}
  for (const [id, value] of Object.entries(values ?? {})) {
    if (id !== 'model') {
      modelValues[id] = { value, source: 'applied' }
    }
  }
  record.valuesByModel[modelId] = modelValues
  writeNativeChatSessionOptionCache(scopeKey, record)
}

export function mergeNativeChatAppliedSessionOptions(
  scopeKey: string,
  values: Record<string, SessionOptionValue>,
  record: NativeChatSessionOptionRecord
): boolean {
  const { model: modelId, ...options } = values
  if (typeof modelId !== 'string' || !modelId) {
    return false
  }

  const previous = record.hostApplied
  record.hostApplied = { ...values }
  let changed = false
  if (record.model?.value !== modelId) {
    if (!shouldApplyHostValue(record.model, previous, 'model', modelId)) {
      writeNativeChatSessionOptionCache(scopeKey, record)
      return false
    }
    if (record.model) {
      for (const [id, tracked] of Object.entries(record.valuesByModel[modelId] ?? {})) {
        if (tracked.source === 'applied') {
          clearTrackedSessionOption(record, modelId, id)
        }
      }
    }
    setTrackedSessionOption(record, 'model', modelId, 'applied')
    changed = true
  }
  for (const [id, value] of Object.entries(options)) {
    const current = getTrackedSessionOption(record, modelId, id)
    if (shouldApplyHostValue(current, previous, id, value)) {
      setTrackedSessionOption(record, id, value, 'applied')
      changed = true
    }
  }
  writeNativeChatSessionOptionCache(scopeKey, record)
  return changed
}

function shouldApplyHostValue(
  current: TrackedNativeChatSessionOption | undefined,
  previous: Record<string, SessionOptionValue> | undefined,
  id: string,
  value: SessionOptionValue
): boolean {
  return (
    previous?.[id] !== value &&
    current?.value !== value &&
    (!current || (previous !== undefined && current.source === 'applied'))
  )
}

/** A picked model drops the old model's other values; any other pick only replaces its own option. */
export function nextAppliedSessionOptionsAfterPick(
  values: Record<string, SessionOptionValue>,
  optionId: string,
  value: SessionOptionValue
): Record<string, SessionOptionValue> {
  return optionId === 'model' ? { model: value } : { ...values, [optionId]: value }
}
