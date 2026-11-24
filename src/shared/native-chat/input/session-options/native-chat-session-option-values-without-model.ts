import type {
  AgentSessionOptionCatalog,
  CatalogOption
} from '../../../agent-session/options/catalog-providers/agent-session-option-catalog-types'
import type { NativeChatSessionOptionRecord } from './native-chat-session-option-state'

/** Options a launch without a model still applies; nothing composes into a model it does not name. */
export function nativeChatOptionsWithoutModel(
  catalog: AgentSessionOptionCatalog | null
): CatalogOption[] {
  return (catalog?.unknownModelOptions ?? []).filter((option) => !option.apply.composedIntoModel)
}

/** Moves the slot values the first reported model offers onto it, keeping their source, then drops the slot. */
export function adoptNativeChatValuesWithoutModel(
  record: NativeChatSessionOptionRecord,
  modelId: string,
  offeredIds: readonly string[]
): boolean {
  const slot = record.valuesWithoutModel
  if (!slot) {
    return false
  }
  let adopted = false
  for (const id of offeredIds) {
    if (record.valuesByModel[modelId]?.[id] === undefined) {
      // Same entry, so a pick dispatched before the report still sees its baseline.
      record.valuesByModel[modelId] = { ...record.valuesByModel[modelId], [id]: slot[id] }
      adopted = true
    }
  }
  delete record.valuesWithoutModel
  return adopted
}

/** Re-picking the model the session already runs keeps the options it runs now, over older ones saved under that model. */
export function carryNativeChatValuesWithoutModel(
  record: NativeChatSessionOptionRecord,
  modelId: string
): void {
  if (!record.valuesWithoutModel) {
    return
  }
  record.valuesByModel[modelId] = { ...record.valuesByModel[modelId], ...record.valuesWithoutModel }
  delete record.valuesWithoutModel
}
