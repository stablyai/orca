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
import { decodeCatalogOptionValue } from '../../../agent-session/options/selection/structured-agent-session-option-codec'
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

export function nativeChatAppliedSessionOptionRecord(
  agent: AgentType,
  values: Record<string, SessionOptionValue> | null | undefined
): NativeChatSessionOptionRecord | null {
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
    return null
  }
  return record
}

export function seedNativeChatAppliedSessionOptions(
  scopeKey: string,
  agent: AgentType,
  values: Record<string, SessionOptionValue> | null | undefined
): boolean {
  const record = nativeChatAppliedSessionOptionRecord(agent, values)
  if (!record) {
    return false
  }
  writeNativeChatSessionOptionCache(scopeKey, record)
  return true
}

// New-tab launches carry saved choices as strings; record booleans as the host applies them.
export function decodeNativeChatAppliedSessionOptions(
  agent: AgentType,
  values: Record<string, SessionOptionValue>
): Record<string, SessionOptionValue> {
  const catalog = getAgentSessionOptionCatalog(agent)
  const options = [
    ...(catalog?.models.flatMap((model) => model.options) ?? []),
    ...(catalog?.unknownModelOptions ?? [])
  ]
  const decoded: Record<string, SessionOptionValue> = {}
  for (const [id, value] of Object.entries(values)) {
    const option = options.find((candidate) => candidate.id === id)
    const next = option ? decodeCatalogOptionValue(option.kind, value) : value
    if (next !== undefined) {
      decoded[id] = next
    }
  }
  return decoded
}

export function fillNativeChatSessionOptionGaps(
  record: NativeChatSessionOptionRecord,
  applied: NativeChatSessionOptionRecord
): void {
  for (const [modelId, values] of Object.entries(applied.valuesByModel)) {
    record.valuesByModel[modelId] = withTrackedValueGapsFilled(
      record.valuesByModel[modelId],
      values
    )
  }
  if (applied.valuesWithoutModel) {
    record.valuesWithoutModel = withTrackedValueGapsFilled(
      record.valuesWithoutModel,
      applied.valuesWithoutModel
    )
  }
}

function withTrackedValueGapsFilled(
  tracked: Record<string, TrackedNativeChatSessionOption> | undefined,
  applied: Record<string, TrackedNativeChatSessionOption>
): Record<string, TrackedNativeChatSessionOption> {
  const gaps = Object.entries(applied).filter(([id]) => tracked?.[id] === undefined)
  // Same object when nothing is missing: a model pick in flight compares the bucket by identity.
  return tracked && gaps.length === 0
    ? tracked
    : { ...tracked, ...Object.fromEntries(gaps.map(([id, value]) => [id, { ...value }])) }
}
