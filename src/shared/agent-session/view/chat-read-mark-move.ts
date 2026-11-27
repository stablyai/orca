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
export type ChatReadMarkAliases = Partial<Record<ChatReadMarkField, Set<string>>>
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
      const keys = (aliases[field] ??= new Set<string>())
      keys.add(key)
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
  aliases: ReadonlySet<string>,
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
  aliases: ReadonlySet<string>,
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

export function someChatReadMarkAlias(
  aliases: ReadonlySet<string> | undefined,
  matches: (alias: string) => boolean
): boolean {
  for (const alias of aliases ?? []) {
    if (matches(alias)) {
      return true
    }
  }
  return false
}

export function moveChatReadMark(
  record: Record<string, number>,
  key: string,
  aliases: ReadonlySet<string>,
  currentTurn?: number,
  movedAliases?: Map<string, string>
): boolean {
  if (!someChatReadMarkAlias(aliases, (alias) => Object.hasOwn(record, alias))) {
    return false
  }
  const value = resolveChatReadMark(record, key, aliases, currentTurn)
  if (movedAliases && value !== undefined) {
    for (const alias of aliases) {
      if (Object.hasOwn(record, alias)) {
        movedAliases.set(alias, key)
      }
    }
  }
  setChatReadMark(record, key, aliases, value)
  return true
}

export function orderMovedChatReadMarks(
  original: Readonly<Record<string, number>>,
  record: Record<string, number>,
  movedAliases: ReadonlyMap<string, string>
): Record<string, number> {
  if (movedAliases.size === 0) {
    return record
  }
  const ordered: Record<string, number> = {}
  for (const key of Object.keys(original)) {
    const destination = movedAliases.get(key) ?? key
    if (Object.hasOwn(record, destination)) {
      ordered[destination] = record[destination]
    }
  }
  return { ...ordered, ...record }
}
