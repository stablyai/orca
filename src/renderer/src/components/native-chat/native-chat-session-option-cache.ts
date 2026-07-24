import type { AgentType } from '../../../../shared/agent-status-types'
import type {
  SessionOptionValue,
  SessionOptionValueSource
} from '../../../../shared/native-chat-session-options'
import {
  clearBoundedScopeCache,
  getBoundedScopeCacheEntry,
  setBoundedScopeCacheEntry
} from './native-chat-composer-scope-cache'

export type TrackedNativeChatSessionOption = {
  value: SessionOptionValue
  source: Exclude<SessionOptionValueSource, 'unknown'>
}

export type NativeChatSessionOptionRecord = {
  agent: AgentType
  model?: TrackedNativeChatSessionOption
  valuesByModel: Record<string, Record<string, TrackedNativeChatSessionOption>>
}

const sessionOptionCache = new Map<string, NativeChatSessionOptionRecord>()

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

export function readNativeChatSessionOptionCache(
  scopeKey: string,
  fallbackScopeKey?: string
): NativeChatSessionOptionRecord | null {
  const record =
    getBoundedScopeCacheEntry(sessionOptionCache, scopeKey) ??
    getBoundedScopeCacheEntry(sessionOptionCache, fallbackScopeKey ?? '')
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

export function clearNativeChatSessionOptionCacheForTests(): void {
  clearBoundedScopeCache(sessionOptionCache)
}
