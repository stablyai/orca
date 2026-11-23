import { chatPaneKey } from '../../../../../../shared/agent-session/view/structured-agent-session-projection'
import type { Tab } from '../../../../../../shared/workspace-layout/tab-groups/tab-types'
import type { AppState } from '../../../types'

type MarkRecord = Readonly<Record<string, number>>
type WebCopyState = Pick<
  AppState,
  'activityClearedAtByPaneKey' | 'manuallyUnreadTurnsByPaneKey' | 'chatReadMarkKeysCopiedHere'
>

const paneKeyLeaf = (paneKey: string): string => paneKey.slice(paneKey.lastIndexOf(':') + 1)

const keysByLeafCache = new WeakMap<MarkRecord, Map<string, string[]>>()
/** A record's keys by their last part; a chat's leaf hashes its conversation, so it names one chat. */
function keysByLeaf(record: MarkRecord): Map<string, string[]> {
  let index = keysByLeafCache.get(record)
  if (!index) {
    index = new Map()
    for (const key of Object.keys(record)) {
      const leaf = paneKeyLeaf(key)
      const keys = index.get(leaf)
      if (keys) {
        keys.push(key)
      } else {
        index.set(leaf, [key])
      }
    }
    keysByLeafCache.set(record, index)
  }
  return index
}

/** Marks saved for this conversation under a tab's key, which a browser can't name after reload. */
function legacyMarks(record: MarkRecord, conversationKey: string): number[] {
  const keys = keysByLeaf(record).get(paneKeyLeaf(conversationKey)) ?? []
  return keys.flatMap((key) => (key === conversationKey ? [] : [record[key]]))
}

/** Ledger keys (conversations) that still have a tab-keyed mark; any other can never copy again. */
export function keepCopiedReadMarkKeys(
  records: Pick<WebCopyState, 'activityClearedAtByPaneKey' | 'manuallyUnreadTurnsByPaneKey'>,
  ...ledgers: Readonly<Record<string, unknown>>[]
): Record<string, number> {
  const kept: Record<string, number> = {}
  for (const ledger of ledgers) {
    for (const [key, at] of Object.entries(ledger)) {
      if (
        typeof at === 'number' &&
        kept[key] === undefined &&
        (legacyMarks(records.activityClearedAtByPaneKey, key).length > 0 ||
          legacyMarks(records.manuallyUnreadTurnsByPaneKey, key).length > 0)
      ) {
        kept[key] = at
      }
    }
  }
  return kept
}

/**
 * A paired web client's own cutoffs and unread turns, for chats the host just delivered. The first
 * time a conversation arrives, every mark saved for it under a tab's key copies to its conversation
 * key (the newest wins, an existing value stays) and the conversation is recorded, so a mark the
 * user later clears is never filled back, whatever order or tab ids its tabs arrive with.
 */
export function copyWebClientChatReadMarks(
  state: WebCopyState,
  tabs: Iterable<Tab>
): Partial<WebCopyState> | null {
  const ledger = state.chatReadMarkKeysCopiedHere
  let patch: Partial<WebCopyState> | null = null
  let nextLedger: Record<string, number> | null = null
  const at = Date.now()
  for (const tab of tabs) {
    if (tab.contentType !== 'agent-session') {
      continue
    }
    const key = chatPaneKey(tab.entityId)
    if (ledger[key] !== undefined || nextLedger?.[key] !== undefined) {
      continue
    }
    let found = false
    for (const name of ['activityClearedAtByPaneKey', 'manuallyUnreadTurnsByPaneKey'] as const) {
      const record = state[name]
      const marks = legacyMarks(record, key)
      if (!marks.length) {
        continue
      }
      found = true
      if (record[key] === undefined) {
        patch ??= {}
        const next = (patch[name] ??= { ...record })
        next[key] = Math.max(...marks)
      }
    }
    if (found) {
      nextLedger ??= { ...ledger }
      nextLedger[key] = at
    }
  }
  return nextLedger ? { ...patch, chatReadMarkKeysCopiedHere: nextLedger } : null
}
