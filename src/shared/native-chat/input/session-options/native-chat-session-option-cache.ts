import type { AgentType } from '../../../agent-status/contracts/agent-status-types'
import type { SessionOptionValue } from '../native-chat-session-options'
import {
  cloneNativeChatSessionOptionRecord,
  createNativeChatSessionOptionRecord,
  type NativeChatSessionOptionRecord,
  type TrackedNativeChatSessionOption
} from './native-chat-session-option-state'
import { setBoundedScopeCacheEntry } from '../composer/native-chat-scope-cache'
import { getAgentSessionOptionCatalog } from '../../../agent-session/options/agent-session-option-catalog'
import { nativeChatOptionsWithoutModel } from './native-chat-session-option-values-without-model'

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
  // A launch naming no model applies only its model-independent options.
  const withoutModel = modelId
    ? null
    : nativeChatOptionsWithoutModel(getAgentSessionOptionCatalog(agent))
  const modelValues: Record<string, TrackedNativeChatSessionOption> = {}
  for (const [id, value] of Object.entries(values ?? {})) {
    if (id !== 'model' && (!withoutModel || withoutModel.some((option) => option.id === id))) {
      modelValues[id] = { value, source: 'applied' }
    }
  }
  const record = createNativeChatSessionOptionRecord(agent)
  if (modelId) {
    record.model = { value: modelId, source: 'applied' }
    record.valuesByModel[modelId] = modelValues
  } else if (Object.keys(modelValues).length > 0) {
    record.valuesWithoutModel = modelValues
  } else {
    return
  }
  writeNativeChatSessionOptionCache(scopeKey, record)
}
