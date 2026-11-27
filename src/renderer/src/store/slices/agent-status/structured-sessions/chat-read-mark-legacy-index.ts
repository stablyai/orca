import {
  chatPaneKeySessionId,
  structuredAgentSessionTabId
} from '../../../../../../shared/agent-session/view/structured-agent-session-projection'
import { isAgentSessionSlotTabId } from '../../../../../../shared/agent-session/view/agent-session-slot-tab-id'
import {
  isReopenedChatTabId,
  isStructuredAgentSessionHostTabId
} from '../../../../../../shared/agent-session/view/structured-agent-session-host-tab-id'
import {
  CHAT_READ_MARK_FIELDS,
  type ChatReadMarkField,
  type ChatReadMarks
} from '@/web/preload-api/preferences/web-chat-read-mark-storage'

export type LegacyIndex = Map<string, Partial<Record<ChatReadMarkField, string[]>>>

export const paneKeyLeaf = (key: string): string => key.slice(key.lastIndexOf(':') + 1)
const structuredTabPrefix = structuredAgentSessionTabId('')

export function indexLegacyKeys(marks: ChatReadMarks): LegacyIndex {
  const index: LegacyIndex = new Map()
  for (const field of CHAT_READ_MARK_FIELDS) {
    for (const key of Object.keys(marks[field])) {
      const separator = key.lastIndexOf(':')
      const tabId = key.slice(0, separator)
      if (
        separator === -1 ||
        (!tabId.startsWith(structuredTabPrefix) &&
          !isReopenedChatTabId(tabId) &&
          !isAgentSessionSlotTabId(tabId) &&
          !isStructuredAgentSessionHostTabId(tabId)) ||
        chatPaneKeySessionId(key) !== null
      ) {
        continue
      }
      const leaf = key.slice(separator + 1)
      let aliases = index.get(leaf)
      if (!aliases) {
        aliases = {}
        index.set(leaf, aliases)
      }
      const keys = (aliases[field] ??= [])
      keys.push(key)
    }
  }
  return index
}
