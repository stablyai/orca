import { copyChatReadMarksToConversationKeys } from '../../../../../shared/agent-session/view/chat-read-mark-copy'
import type { PersistedUIState } from '../../../../../shared/orca-profiles/persisted-ui-state-types'
import type { PersistedUIWriteBaseline } from '@/store/slices/ui/persisted-ui-write-baseline'
import {
  isPlainPersistedRecord,
  isSafePersistedRecordKey,
  sanitizePaneKeyTimestampRecord
} from '@/store/slices/ui/ui-slice-hydration-sanitizers'
import { UI_STORAGE_KEY, readJson, writeJson } from '../web-storage'

export const CHAT_READ_MARK_FIELDS = [
  'activityClearedAtByPaneKey',
  'manuallyUnreadTurnsByPaneKey'
] as const
export type ChatReadMarkField = (typeof CHAT_READ_MARK_FIELDS)[number]
export type ChatReadMarks = Pick<PersistedUIWriteBaseline, ChatReadMarkField>

export function applyWebChatReadMarkEdits(
  stored: Record<string, number>,
  current: Record<string, number>,
  baseline: Record<string, number>
): Record<string, number> {
  const next = { ...stored }
  for (const key of Object.keys(baseline)) {
    if (!Object.hasOwn(current, key)) {
      delete next[key]
    }
  }
  for (const [key, value] of Object.entries(current)) {
    if (value !== baseline[key]) {
      next[key] = value
    }
  }
  return next
}

function storedMarkRecord(record: Record<string, number> | undefined): Record<string, number> {
  return isPlainPersistedRecord(record) ? record : {}
}

export function mergeWebChatReadMarkEdits(
  stored: Partial<PersistedUIState>,
  changes: Partial<ChatReadMarks>,
  baseline: ChatReadMarks
): void {
  for (const field of CHAT_READ_MARK_FIELDS) {
    const current = changes[field]
    if (current) {
      stored[field] = sanitizePaneKeyTimestampRecord(
        applyWebChatReadMarkEdits(storedMarkRecord(stored[field]), current, baseline[field]),
        current
      )
    }
  }
}

export function writeWebChatReadMarkEdits(
  changes: Partial<ChatReadMarks>,
  baseline: ChatReadMarks
): void {
  const stored = readJson<Partial<PersistedUIState>>(UI_STORAGE_KEY, {})
  mergeWebChatReadMarkEdits(stored, changes, baseline)
  writeJson(UI_STORAGE_KEY, stored)
}

export function commitWebChatReadMarkCopy(
  changes: Partial<ChatReadMarks>,
  baseline: ChatReadMarks,
  sessionIds?: () => Iterable<string>
): ChatReadMarks & { chatReadMarksCopiedHere: true } {
  const stored = readJson<Partial<PersistedUIState>>(UI_STORAGE_KEY, {})
  const marks = {
    activityClearedAtByPaneKey: storedMarkRecord(stored.activityClearedAtByPaneKey),
    manuallyUnreadTurnsByPaneKey: storedMarkRecord(stored.manuallyUnreadTurnsByPaneKey)
  }
  for (const field of CHAT_READ_MARK_FIELDS) {
    const current = changes[field]
    if (current) {
      marks[field] = applyWebChatReadMarkEdits(marks[field], current, baseline[field])
    }
  }
  if (stored.chatReadMarksCopiedHere !== true && sessionIds) {
    const sources = { ...marks }
    for (const field of CHAT_READ_MARK_FIELDS) {
      sources[field] = Object.fromEntries(
        Object.entries(marks[field]).filter(
          ([key, value]) => isSafePersistedRecordKey(key) && Number.isFinite(value) && value > 0
        )
      )
    }
    const copied = copyChatReadMarksToConversationKeys(sources, sessionIds())
    for (const field of CHAT_READ_MARK_FIELDS) {
      for (const [key, value] of Object.entries(copied?.[field] ?? {})) {
        // A pending deletion, including one of a stored destination, remains a deletion.
        if (
          !Object.hasOwn(marks[field], key) &&
          !(changes[field] && Object.hasOwn(baseline[field], key))
        ) {
          marks[field][key] = value
        }
      }
    }
  }
  for (const field of CHAT_READ_MARK_FIELDS) {
    marks[field] = sanitizePaneKeyTimestampRecord(marks[field], changes[field] ?? baseline[field])
  }
  const result = { ...marks, chatReadMarksCopiedHere: true as const }
  writeJson(UI_STORAGE_KEY, { ...stored, ...result })
  return result
}
