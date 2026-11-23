import type { Tab } from '../../workspace-layout/tab-groups/tab-types'
import { chatPaneAddressTabId, chatPaneKey } from './structured-agent-session-projection'

type ChatTab = Pick<Tab, 'id' | 'contentType' | 'entityId'>

/** The key a chat tab's read marks were saved under before pane keys followed the conversation, or
 *  null when that key is already the conversation's. */
export function chatTabReadMarkKey(tab: ChatTab): string | null {
  if (tab.contentType !== 'agent-session') {
    return null
  }
  const address = chatPaneAddressTabId(tab.entityId)
  return tab.id === address ? null : `${tab.id}${chatPaneKey(tab.entityId).slice(address.length)}`
}

export type ChatReadMarkRecords = Readonly<Record<string, Readonly<Record<string, number>>>>

/**
 * COMPAT(2026-11, remove after 2027-05): a chat in a tab whose id isn't its conversation address (a
 * replaced conversation, a reopened tab) saved its read marks under the tab's key before pane keys
 * followed the conversation. Run once per store, this adds each such mark under the conversation key
 * when that key has none, the larger of several sources winning. It never deletes or changes a key:
 * originals stay readable by older builds, and a conversation-keyed value is newer truth.
 */
export function copyChatReadMarksToConversationKeys<R extends ChatReadMarkRecords>(
  records: R,
  tabs: Iterable<ChatTab>
): Partial<{ [K in keyof R]: Record<string, number> }> | null {
  const added: Partial<Record<keyof R, Record<string, number>>> = {}
  let changed = false
  for (const tab of tabs) {
    const tabKey = chatTabReadMarkKey(tab)
    if (tabKey === null) {
      continue
    }
    const key = chatPaneKey(tab.entityId)
    for (const name in records) {
      const record = records[name]
      const value = record[tabKey]
      if (value === undefined || record[key] !== undefined) {
        continue
      }
      const next = (added[name] ??= { ...record })
      next[key] = Math.max(next[key] ?? value, value)
      changed = true
    }
  }
  return changed ? added : null
}
