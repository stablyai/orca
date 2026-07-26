import type { CatalogMidSessionApply } from '../../../../shared/agent-session-option-catalog'
import type {
  NativeChatSessionOptionRecord,
  TrackedNativeChatSessionOption
} from './native-chat-session-option-cache'

/** Why: one predicate for flip-only mid-session commands so snapshot,
 * absolute apply, value-less actions, and typed-command recording stay aligned. */
export function isFlipOnlyMidSession(
  midSession: CatalogMidSessionApply | undefined
): midSession is Extract<CatalogMidSessionApply, { kind: 'toggle-command' }> {
  return midSession?.kind === 'toggle-command'
}

export function getTrackedOption(
  record: NativeChatSessionOptionRecord,
  modelId: string | null,
  optionId: string
): TrackedNativeChatSessionOption | undefined {
  if (!modelId) {
    return undefined
  }
  return record.valuesByModel[modelId]?.[optionId]
}

export function clearTrackedOption(
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
