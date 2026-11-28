import { isAgentSessionId } from '../../../../../../shared/agent-session/lifecycle/agent-session-record'
import { recordDraft, type RecordDraft } from '@/store/record-transitions/keyed-record-transitions'
import {
  CHAT_READ_MARK_FIELDS,
  indexLegacyChatReadMarks,
  paneKeyLeaf,
  recordCanonicalChatReadMarkMatches,
  recordChatReadMarkMatch,
  resolveChatReadMark,
  type ChatReadMarkAliases,
  type ChatReadMarkField,
  type ChatReadMarkMatches,
  type LegacyChatReadMarkIndex,
  type ChatReadMarks
} from '../../../../../../shared/agent-session/view/chat-read-mark-move'
import { capPaneKeyTimestampRecord } from '../../../../../../shared/agent-session/view/pane-key-timestamp-record'
import {
  CHAT_PANE_ADDRESS_PREFIX,
  chatPaneKeySessionId
} from '../../../../../../shared/agent-session/view/structured-agent-session-projection'
import { isStablePaneId } from '../../../../../../shared/workspace-layout/stable-pane-id'

const MIGRATION_DEADLINE_MS = 120_000

let legacyIndex: LegacyChatReadMarkIndex = new Map()
let webIndex: LegacyChatReadMarkIndex | undefined
let matches: ChatReadMarkMatches = new Map()
let receiptWritesFailed = false

function hasBrowserAliases(aliases: ChatReadMarkAliases): boolean {
  return Boolean(aliases.activityClearedAtByPaneKey || aliases.manuallyUnreadTurnsByPaneKey)
}

export function indexLoadedChatReadMarks(marks: ChatReadMarks, web: boolean): void {
  legacyIndex = indexLegacyChatReadMarks(marks)
  webIndex = web
    ? new Map([...legacyIndex].filter(([, aliases]) => hasBrowserAliases(aliases)))
    : undefined
  matches = new Map()
  receiptWritesFailed = false
  if (web) {
    confirmChatReadMarkMatches({
      activityClearedAtByPaneKey: marks.activityClearedAtByPaneKey,
      manuallyUnreadTurnsByPaneKey: marks.manuallyUnreadTurnsByPaneKey
    })
  } else if (legacyIndex.size > 0) {
    recordCanonicalChatReadMarkMatches(legacyIndex, matches, marks)
  }
}

export function hasLoadedChatReadMarkAliases(): boolean {
  return legacyIndex.size > 0
}

export function capWebChatReadMarkRecord(
  field: ChatReadMarkField,
  record: Record<string, number>,
  retain?: Readonly<Record<string, number>>
): Record<string, number> {
  const index = webIndex
  if (!index?.size || field === 'acknowledgedAgentsByPaneKey') {
    return capPaneKeyTimestampRecord(record, retain)
  }
  return capPaneKeyTimestampRecord(record, retain, () => {
    const pendingSubjects = new Map<string, string>()
    for (const [leaf, aliases] of index) {
      const keys = aliases[field]
      if (!keys) {
        continue
      }
      // A pending leaf can share a cap slot before a receipt verifies its destination.
      const match = matches.get(leaf)
      const [firstKey] = keys
      const subject = match === undefined && isStablePaneId(leaf) ? firstKey : match
      for (const key of keys) {
        pendingSubjects.set(key, subject ?? key)
      }
    }
    return pendingSubjects
  })
}

export function canMoveWebChatReadMarks(): boolean {
  return (
    !receiptWritesFailed &&
    webIndex !== undefined &&
    webIndex.size > 0 &&
    performance.now() < MIGRATION_DEADLINE_MS
  )
}

export function stopWebChatReadMarkMoves(): void {
  receiptWritesFailed = true
}

export function loadedChatReadMarkMatches(): ChatReadMarkMatches {
  return matches
}

export function matchWebChatReadMarkReceipt(
  receiptMatches: ChatReadMarkMatches,
  sessionId: string
): void {
  if (webIndex) {
    recordChatReadMarkMatch(webIndex, receiptMatches, sessionId)
  }
}

export function confirmChatReadMarkMatches(marks: Partial<ChatReadMarks>): void {
  if (webIndex?.size) {
    recordCanonicalChatReadMarkMatches(webIndex, matches, marks)
  }
}

export function adoptChatReadMarkAliases(marks: Partial<ChatReadMarks>): void {
  if (!CHAT_READ_MARK_FIELDS.some((field) => marks[field])) {
    return
  }
  for (const [leaf, aliases] of legacyIndex) {
    for (const field of CHAT_READ_MARK_FIELDS) {
      const record = marks[field]
      const keys = aliases[field]
      if (record && keys) {
        for (const key of keys) {
          if (!Object.hasOwn(record, key)) {
            keys.delete(key)
          }
        }
        if (keys.size === 0) {
          delete aliases[field]
        }
      }
    }
    if (!hasBrowserAliases(aliases)) {
      webIndex?.delete(leaf)
    }
    if (CHAT_READ_MARK_FIELDS.every((field) => !aliases[field])) {
      legacyIndex.delete(leaf)
      matches.delete(leaf)
    }
  }
}

export function aliasesAtChatReadMarkLeaf(
  field: ChatReadMarkField,
  leaf: string
): Iterable<string> {
  return legacyIndex.get(leaf)?.[field] ?? []
}

// Null means the alias is indexed but its conversation has no unique match.
export function knownChatReadMarkKey(
  field: ChatReadMarkField,
  alias: string
): string | null | undefined {
  if (legacyIndex.size === 0) {
    return undefined
  }
  const leaf = paneKeyLeaf(alias)
  if (legacyIndex.get(leaf)?.[field]?.has(alias)) {
    return matches.get(leaf) ?? null
  }
  return undefined
}

export function chatReadMarkAliases(
  field: ChatReadMarkField,
  key: string
): ReadonlySet<string> | undefined {
  if (legacyIndex.size === 0 || !key.startsWith(CHAT_PANE_ADDRESS_PREFIX)) {
    return undefined
  }
  const leaf = paneKeyLeaf(key)
  const aliases = legacyIndex.get(leaf)?.[field]
  const match = matches.get(leaf)
  if (!aliases || (match !== undefined && match !== key)) {
    return undefined
  }
  if (match === key) {
    return aliases
  }
  const sessionId = chatPaneKeySessionId(key)
  return sessionId !== null && isAgentSessionId(sessionId) ? aliases : undefined
}

function aliasesForChatReadMarkEdit(field: ChatReadMarkField, key: string): Iterable<string> {
  const aliases = chatReadMarkAliases(field, key)
  if (aliases) {
    const sessionId = chatPaneKeySessionId(key)
    if (sessionId !== null) {
      recordChatReadMarkMatch(legacyIndex, matches, sessionId)
    }
  }
  return aliases ?? []
}

export function readWebChatMark(
  state: Partial<ChatReadMarks>,
  field: ChatReadMarkField,
  key: string,
  currentTurn?: number
): number | undefined {
  const record = state[field]
  if (!record) {
    return undefined
  }
  const aliases = chatReadMarkAliases(field, key)
  if (aliases) {
    return resolveChatReadMark(record, key, aliases, currentTurn)
  }
  const stamp = record[key]
  return currentTurn === undefined || stamp === currentTurn ? stamp : undefined
}

export function deleteChatReadMarkAliases(
  draft: RecordDraft<number>,
  field: ChatReadMarkField,
  key: string
): void {
  for (const alias of aliasesForChatReadMarkEdit(field, key)) {
    draft.delete(alias)
  }
}

export function deleteChatReadMark(
  draft: RecordDraft<number>,
  field: ChatReadMarkField,
  key: string
): void {
  deleteChatReadMarkAliases(draft, field, key)
  draft.delete(key)
}

export function removeChatReadMark(
  record: Record<string, number>,
  field: ChatReadMarkField,
  key: string
): Record<string, number> {
  const draft = recordDraft(record)
  deleteChatReadMark(draft, field, key)
  return draft.finish()
}
