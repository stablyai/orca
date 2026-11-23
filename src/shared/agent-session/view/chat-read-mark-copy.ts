import { chatPaneKey, chatPaneKeySessionId } from './structured-agent-session-projection'

export type ChatReadMarkRecords = Readonly<Record<string, Readonly<Record<string, number>>>>

// Every build keeps at most this many keys per saved mark record, newest first.
export const PANE_KEY_TIMESTAMP_MAX_ENTRIES = 500

const paneKeyLeaf = (paneKey: string): string => paneKey.slice(paneKey.lastIndexOf(':') + 1)

/**
 * A mark record within PANE_KEY_TIMESTAMP_MAX_ENTRIES keys. Over it, a tab-keyed original whose
 * value also sits under its conversation key goes first, oldest first, so a copy never makes an
 * older build's newest-keys cut drop a mark it would have kept; then the newest keys win.
 */
export function boundPaneKeyTimestampRecord(
  record: Record<string, number>
): Record<string, number> {
  const entries = Object.entries(record)
  if (entries.length <= PANE_KEY_TIMESTAMP_MAX_ENTRIES) {
    return record
  }
  const conversationLeaves = new Set(
    entries.flatMap(([key]) => (chatPaneKeySessionId(key) === null ? [] : [paneKeyLeaf(key)]))
  )
  const redundant = new Set(
    entries
      .filter(
        ([key]) => chatPaneKeySessionId(key) === null && conversationLeaves.has(paneKeyLeaf(key))
      )
      .toSorted(([, left], [, right]) => left - right)
      .slice(0, entries.length - PANE_KEY_TIMESTAMP_MAX_ENTRIES)
      .map(([key]) => key)
  )
  return Object.fromEntries(
    entries
      .filter(([key]) => !redundant.has(key))
      .toSorted(([, left], [, right]) => right - left)
      .slice(0, PANE_KEY_TIMESTAMP_MAX_ENTRIES)
  )
}

/**
 * COMPAT(2026-11, remove after 2027-05): a chat in a tab whose id isn't its conversation address (a
 * replaced conversation, a reopened tab) saved its read marks under the tab's key before pane keys
 * followed the conversation. Both keys end in the conversation's hash, so run once per store, this
 * adds each such mark under the conversation key when that key has none, the largest source
 * winning. It never changes a key, and keeps originals for older builds unless the record would
 * pass its key limit; a conversation-keyed value is newer truth.
 */
export function copyChatReadMarksToConversationKeys<R extends ChatReadMarkRecords>(
  records: R,
  sessionIds: Iterable<string>
): Partial<{ [K in keyof R]: Record<string, number> }> | null {
  const conversationKeyByLeaf = new Map<string, string>()
  for (const sessionId of sessionIds) {
    const key = chatPaneKey(sessionId)
    conversationKeyByLeaf.set(paneKeyLeaf(key), key)
  }
  const added: Partial<Record<keyof R, Record<string, number>>> = {}
  let changed = false
  for (const name in records) {
    const record = records[name]
    for (const [tabKey, value] of Object.entries(record)) {
      const key = conversationKeyByLeaf.get(paneKeyLeaf(tabKey))
      if (key === undefined || key === tabKey || record[key] !== undefined) {
        continue
      }
      const next = (added[name] ??= { ...record })
      next[key] = Math.max(next[key] ?? value, value)
      changed = true
    }
  }
  if (!changed) {
    return null
  }
  for (const name in added) {
    const record = added[name]
    if (record) {
      added[name] = boundPaneKeyTimestampRecord(record)
    }
  }
  return added
}
