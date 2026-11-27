import { isAgentSessionId } from '../lifecycle/agent-session-record'
import { isAgentSessionSlotTabId } from './agent-session-slot-tab-id'
import {
  isReopenedChatTabId,
  isStructuredAgentSessionHostTabId
} from './structured-agent-session-host-tab-id'
import {
  chatPaneKey,
  chatPaneKeySessionId,
  structuredAgentSessionTabId
} from './structured-agent-session-projection'

export type ChatReadMarkField =
  | 'acknowledgedAgentsByPaneKey'
  | 'activityClearedAtByPaneKey'
  | 'manuallyUnreadTurnsByPaneKey'

export type ChatReadMarks = Record<ChatReadMarkField, Record<string, number>>
export type ChatReadMarkAliases = Partial<Record<ChatReadMarkField, string[]>>
export type LegacyChatReadMarkIndex = Map<string, ChatReadMarkAliases>
export type ChatReadMarkMatches = Map<string, string | null>

export const CHAT_READ_MARK_FIELDS: readonly ChatReadMarkField[] = [
  'acknowledgedAgentsByPaneKey',
  'activityClearedAtByPaneKey',
  'manuallyUnreadTurnsByPaneKey'
]

export const paneKeyLeaf = (key: string): string => key.slice(key.lastIndexOf(':') + 1)
const structuredTabPrefix = structuredAgentSessionTabId('')

export function indexLegacyChatReadMarks(marks: Partial<ChatReadMarks>): LegacyChatReadMarkIndex {
  const index: LegacyChatReadMarkIndex = new Map()
  for (const field of CHAT_READ_MARK_FIELDS) {
    for (const key of Object.keys(marks[field] ?? {})) {
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

export function recordChatReadMarkMatch(
  index: LegacyChatReadMarkIndex,
  matches: ChatReadMarkMatches,
  sessionId: string
): void {
  if (!isAgentSessionId(sessionId)) {
    return
  }
  const key = chatPaneKey(sessionId)
  const leaf = paneKeyLeaf(key)
  if (index.has(leaf)) {
    const previous = matches.get(leaf)
    matches.set(leaf, previous === undefined || previous === key ? key : null)
  }
}

export function recordCanonicalChatReadMarkMatches(
  index: LegacyChatReadMarkIndex,
  matches: ChatReadMarkMatches,
  marks: Partial<ChatReadMarks>
): void {
  for (const field of CHAT_READ_MARK_FIELDS) {
    for (const key of Object.keys(marks[field] ?? {})) {
      const sessionId = chatPaneKeySessionId(key)
      if (sessionId !== null) {
        recordChatReadMarkMatch(index, matches, sessionId)
      }
    }
  }
}

export function resolveChatReadMark(
  record: Readonly<Record<string, number>>,
  key: string,
  aliases: readonly string[],
  currentTurn?: number
): number | undefined {
  let mark: number | undefined
  for (const candidate of [key, ...aliases]) {
    const value = record[candidate]
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      if (currentTurn !== undefined) {
        if (value === currentTurn) {
          return value
        }
      } else if (mark === undefined || value > mark) {
        mark = value
      }
    }
  }
  return mark
}

export function setChatReadMark(
  record: Record<string, number>,
  key: string,
  aliases: readonly string[],
  value: number | undefined
): void {
  for (const alias of aliases) {
    delete record[alias]
  }
  if (value === undefined) {
    delete record[key]
  } else {
    record[key] = value
  }
}

export function moveChatReadMark(
  record: Record<string, number>,
  key: string,
  aliases: readonly string[],
  currentTurn?: number
): boolean {
  if (!aliases.some((alias) => Object.hasOwn(record, alias))) {
    return false
  }
  setChatReadMark(record, key, aliases, resolveChatReadMark(record, key, aliases, currentTurn))
  return true
}
