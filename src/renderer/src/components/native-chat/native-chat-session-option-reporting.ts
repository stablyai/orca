import type { SessionOptionValue } from '../../../../shared/native-chat-session-options'
import type { NativeChatSessionOptionRecord } from './native-chat-session-option-cache'

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
