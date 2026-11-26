import { chatPaneKey } from './structured-agent-session-projection'

export type ChatReadMarkRecords = Readonly<Record<string, Readonly<Record<string, number>>>>

const paneKeyLeaf = (paneKey: string): string => paneKey.slice(paneKey.lastIndexOf(':') + 1)

/**
 * COMPAT(2026-11, remove after 2027-05): a chat in a tab whose id isn't its conversation address (a
 * replaced conversation, a reopened tab) saved its read marks under the tab's key before pane keys
 * followed the conversation. Both keys end in the conversation's hash, so run once per store, this
 * adds each such mark under the conversation key when that key has none, the largest source
 * winning. Originals stay readable by older builds, and opted-in records keep the newer mark.
 */
export function copyChatReadMarksToConversationKeys<R extends ChatReadMarkRecords>(
  records: R,
  sessionIds: Iterable<string>,
  keepNewerValueFor?: ReadonlySet<keyof R>
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
      if (key === undefined || key === tabKey) {
        continue
      }
      const existing = record[key]
      if (existing !== undefined && !(keepNewerValueFor?.has(name) && value > existing)) {
        continue
      }
      const next = (added[name] ??= { ...record })
      next[key] = Math.max(next[key] ?? value, value)
      changed = true
    }
  }
  return changed ? added : null
}
