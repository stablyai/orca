import type {
  AgentSessionOptionCatalog,
  CatalogModel
} from '../../../../shared/agent-session-option-catalog'
import type {
  SessionOptionDescriptor,
  NativeChatLiveOptionTransport
} from '../../../../shared/native-chat/input/native-chat-session-options'
import {
  buildNativeChatSessionOptionSnapshot as buildSharedSnapshot,
  type NativeChatSessionOptionMode
} from '../../../../shared/native-chat/input/native-chat-session-option-snapshot'

import type { NativeChatSessionOptionRecord } from '../../../../shared/native-chat/input/native-chat-session-option-state'
import { translate } from '@/i18n/i18n'

export function buildNativeChatSessionOptionSnapshot(args: {
  catalog: AgentSessionOptionCatalog
  models: readonly CatalogModel[]
  record: NativeChatSessionOptionRecord
  mode: NativeChatSessionOptionMode
  liveTransport: NativeChatLiveOptionTransport
}): SessionOptionDescriptor[] {
  return buildSharedSnapshot({
    ...args,
    modelLabel: translate('components.native-chat.composer.model', 'Model')
  })
}
