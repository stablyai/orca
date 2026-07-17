import {
  findCatalogModel,
  type AgentSessionOptionCatalog,
  type CatalogModel,
  type CatalogOptionApply
} from '../../../../shared/agent-session-option-catalog'
import type { SessionOptionValue } from '../../../../shared/native-chat-session-options'
import type { NativeChatSessionOptionRecord } from './native-chat-session-option-cache'
import { flattenNativeChatSessionOptionRecord } from './native-chat-session-option-snapshot'

export function buildNativeChatSessionOptionCommand(args: {
  optionId: string
  value: SessionOptionValue
  apply: CatalogOptionApply
  modelId: string | null
  catalog: AgentSessionOptionCatalog
  models: CatalogModel[]
  record: NativeChatSessionOptionRecord
}): string | null {
  const midSession = args.apply.midSession
  if (midSession?.kind === 'command') {
    return midSession.build(args.value)
  }
  if (midSession?.kind === 'toggle-command' || midSession?.kind === 'agent-picker') {
    return midSession.command
  }
  if (!args.apply.composedIntoModel || !args.modelId || !args.catalog.composeModelValue) {
    return null
  }
  const model = findCatalogModel({ ...args.catalog, models: args.models }, args.modelId)
  const values = flattenNativeChatSessionOptionRecord(args.record, args.modelId)
  for (const option of model?.options ?? []) {
    values[option.id] ??= option.kind.defaultValue
  }
  values[args.optionId] = args.value
  const composed = args.catalog.composeModelValue(args.modelId, values)
  return args.catalog.modelApply.midSession?.kind === 'command'
    ? args.catalog.modelApply.midSession.build(composed)
    : null
}
