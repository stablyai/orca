import {
  chatPaneKeySessionId,
  structuredAgentSessionTabId
} from '../../../../../../shared/agent-session/view/structured-agent-session-projection'
import { isAgentSessionSlotTabId } from '../../../../../../shared/agent-session/view/agent-session-slot-tab-id'
import {
  isReopenedChatTabId,
  isStructuredAgentSessionHostTabId
} from '../../../../../../shared/agent-session/view/structured-agent-session-host-tab-id'

export const paneKeyLeaf = (key: string): string => key.slice(key.lastIndexOf(':') + 1)
const structuredTabPrefix = structuredAgentSessionTabId('')

export function indexLegacyKeys(record: Record<string, number>): Map<string, string[]> {
  const index = new Map<string, string[]>()
  for (const key of Object.keys(record)) {
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
    const aliases = index.get(leaf)
    if (aliases) {
      aliases.push(key)
    } else {
      index.set(leaf, [key])
    }
  }
  return index
}
