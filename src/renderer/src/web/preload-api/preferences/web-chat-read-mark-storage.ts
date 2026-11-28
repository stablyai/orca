import {
  moveChatReadMark,
  orderMovedChatReadMarks,
  setChatReadMark,
  someChatReadMarkAlias,
  type ChatReadMarks
} from '../../../../../shared/agent-session/view/chat-read-mark-move'
import { readPaneKeyTimestampRecord } from '../../../../../shared/agent-session/view/pane-key-timestamp-record'
import {
  adoptChatReadMarkAliases,
  aliasesAtChatReadMarkLeaf,
  capWebChatReadMarkRecord,
  chatReadMarkAliases,
  confirmChatReadMarkMatches,
  loadedChatReadMarkMatches,
  stopWebChatReadMarkMoves
} from '@/store/slices/agent-status/structured-sessions/chat-read-mark-aliases'
import { isPlainPersistedRecord } from '@/store/slices/ui/ui-slice-hydration-sanitizers'
import { UI_STORAGE_KEY, readJson, writeJson } from '../web-storage'

type WebChatReadMarkField = 'activityClearedAtByPaneKey' | 'manuallyUnreadTurnsByPaneKey'
export type WebChatReadMarks = Pick<ChatReadMarks, WebChatReadMarkField>

export const WEB_CHAT_READ_MARK_FIELDS: readonly WebChatReadMarkField[] = [
  'activityClearedAtByPaneKey',
  'manuallyUnreadTurnsByPaneKey'
]

function webChatReadMarkRecords(stored: Record<string, unknown>): WebChatReadMarks {
  return {
    activityClearedAtByPaneKey: readPaneKeyTimestampRecord(stored.activityClearedAtByPaneKey),
    manuallyUnreadTurnsByPaneKey: readPaneKeyTimestampRecord(stored.manuallyUnreadTurnsByPaneKey)
  }
}

function readStoredWebUIForMove(): Record<string, unknown> {
  const raw = window.localStorage.getItem(UI_STORAGE_KEY)
  const stored: unknown = raw === null ? {} : JSON.parse(raw)
  if (
    !isPlainPersistedRecord(stored) ||
    WEB_CHAT_READ_MARK_FIELDS.some(
      (field) => Object.hasOwn(stored, field) && !isPlainPersistedRecord(stored[field])
    )
  ) {
    throw new TypeError('Invalid browser UI storage')
  }
  return stored
}

function applyWebChatReadMarkEdits(
  stored: Record<string, number>,
  current: Record<string, number>,
  baseline: Record<string, number>
): void {
  for (const key of Object.keys(baseline)) {
    if (!Object.hasOwn(current, key)) {
      delete stored[key]
    }
  }
  for (const [key, value] of Object.entries(current)) {
    if (value !== baseline[key]) {
      stored[key] = value
    }
  }
}

export function rebaseWebChatReadMarks(
  stored: WebChatReadMarks,
  changes: Partial<WebChatReadMarks>,
  baseline: WebChatReadMarks,
  moveKeys?: ReadonlySet<string>,
  currentTurn?: (key: string) => number | undefined
): { marks: WebChatReadMarks; changed: boolean } {
  const marks: WebChatReadMarks = {
    activityClearedAtByPaneKey: stored.activityClearedAtByPaneKey,
    manuallyUnreadTurnsByPaneKey: stored.manuallyUnreadTurnsByPaneKey
  }
  let changed = false
  confirmChatReadMarkMatches(marks)
  for (const field of WEB_CHAT_READ_MARK_FIELDS) {
    const current = changes[field]
    if (!current && !moveKeys?.size) {
      continue
    }
    const record = { ...stored[field] }
    const movedAliases = moveKeys?.size ? new Map<string, string>() : undefined
    let moved = false
    if (current) {
      applyWebChatReadMarkEdits(record, current, baseline[field])
    }
    for (const [leaf, key] of loadedChatReadMarkMatches()) {
      if (key === null) {
        // A newly ambiguous leaf cannot retire a physical key from an earlier edit.
        for (const alias of aliasesAtChatReadMarkLeaf(field, leaf)) {
          if (Object.hasOwn(stored[field], alias)) {
            record[alias] = stored[field][alias]
          } else {
            delete record[alias]
          }
        }
        continue
      }
      const aliases = chatReadMarkAliases(field, key)
      if (!aliases) {
        continue
      }
      if (
        current &&
        (current[key] !== baseline[field][key] ||
          someChatReadMarkAlias(aliases, (alias) => current[alias] !== baseline[field][alias]))
      ) {
        setChatReadMark(record, key, aliases, current[key])
      } else if (moveKeys?.has(key)) {
        const turn = field === 'manuallyUnreadTurnsByPaneKey' ? currentTurn?.(key) : undefined
        moved = moveChatReadMark(record, key, aliases, turn, movedAliases) || moved
      }
    }
    if (current || moved) {
      marks[field] = readPaneKeyTimestampRecord(
        movedAliases ? orderMovedChatReadMarks(stored[field], record, movedAliases) : record
      )
      changed = true
    }
  }
  return { marks, changed }
}

export function writeWebChatReadMarkEdits(
  changes: Partial<WebChatReadMarks>,
  baseline: WebChatReadMarks,
  options?: {
    moveKeys?: ReadonlySet<string>
    currentTurn?: (key: string) => number | undefined
    retain?: WebChatReadMarks
    mergeUI?: (stored: Record<string, unknown>) => Record<string, unknown>
  }
): WebChatReadMarks {
  try {
    const stored = options?.moveKeys?.size
      ? readStoredWebUIForMove()
      : readJson<Record<string, unknown>>(UI_STORAGE_KEY, {})
    const storedMarks = webChatReadMarkRecords(stored)
    const { marks, changed } = rebaseWebChatReadMarks(
      storedMarks,
      changes,
      baseline,
      options?.moveKeys,
      options?.currentTurn
    )
    if (changed || options?.mergeUI) {
      // Keep this tab's cutoffs available for Undo until the next hydration cap.
      for (const field of WEB_CHAT_READ_MARK_FIELDS) {
        if (marks[field] !== storedMarks[field]) {
          marks[field] = capWebChatReadMarkRecord(
            field,
            marks[field],
            changes[field] ?? options?.retain?.[field]
          )
        }
      }
      writeJson(UI_STORAGE_KEY, { ...(options?.mergeUI?.(stored) ?? stored), ...marks })
    }
    adoptChatReadMarkAliases(marks)
    return marks
  } catch (error) {
    stopWebChatReadMarkMoves()
    throw error
  }
}
