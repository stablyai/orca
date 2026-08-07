import type {
  AgentSessionOptionCatalog,
  CatalogModel
} from '../../../../shared/agent-session-option-catalog'
import type { SessionOptionDescriptor } from '../../../../shared/native-chat-session-options'
import {
  buildNativeChatSessionOptionSnapshot as buildSharedSnapshot,
  withTrackedNativeChatModel,
  type NativeChatSessionOptionMode
} from '../../../../shared/native-chat-session-option-snapshot'
import {
  flattenNativeChatSessionOptionRecord,
  type NativeChatSessionOptionRecord
} from '../../../../shared/native-chat-session-option-state'
import { translate } from '@/i18n/i18n'

export type { NativeChatSessionOptionMode }
export { flattenNativeChatSessionOptionRecord, withTrackedNativeChatModel }

export function buildNativeChatSessionOptionSnapshot(args: {
  catalog: AgentSessionOptionCatalog
  models: readonly CatalogModel[]
  record: NativeChatSessionOptionRecord
  mode: NativeChatSessionOptionMode
}): SessionOptionDescriptor[] {
  return buildSharedSnapshot({
    ...args,
    modelLabel: translate('components.native-chat.composer.model', 'Model')
  })
}
