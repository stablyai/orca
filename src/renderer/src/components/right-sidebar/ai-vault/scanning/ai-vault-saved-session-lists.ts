// Last list per scope, kept across restarts so History can paint it while the rescan runs.

import type {
  AiVaultListResult,
  AiVaultSession
} from '../../../../../../shared/ai-vault/contracts/ai-vault-types'
import { latestSessionConversationTurn } from '../../../../../../shared/ai-vault/session-display/ai-vault-session-display'
import { useAppStore } from '@/store/index'
import { isWebClientLocation } from '@/lib/web-client-location'
import {
  committedTransaction,
  indexedDbConnection,
  settledRequest
} from '@/lib/indexeddb-connection'
import type { AiVaultSessionLimit } from '../session-list/ai-vault-session-limit'

const DATABASE_NAME = 'orca-ai-vault-session-lists'
const DATABASE_VERSION = 1
const LISTS = 'lists'
const SAVED_AT = 'savedAt'
const MAX_SAVED_LISTS = 8
// The saved copy only has to fill the first screens until the scan replaces it.
const MAX_SAVED_ROWS = 250
// Bump when AiVaultSession changes shape, so rows saved by an older build are never painted.
const ROW_FORMAT = 1

export type SavedAiVaultSessionList = { limit: AiVaultSessionLimit; result: AiVaultListResult }

type StoredList = {
  format: typeof ROW_FORMAT
  savedAt: number
  limit: AiVaultSessionLimit
  sessions: AiVaultSession[]
}

// A web origin can be re-paired to another host, so it keeps nothing.
function savedListsAvailable(): boolean {
  return typeof indexedDB !== 'undefined' && !isWebClientLocation()
}

// Profiles share one IndexedDB, so each key names its profile.
function storageKey(key: string): string | null {
  const profileId = useAppStore.getState().activeOrcaProfileId
  return savedListsAvailable() && profileId ? JSON.stringify([profileId, key]) : null
}

let connection: (() => Promise<IDBDatabase>) | null = null
// The rows each stored key last wrote. Callers pass the panel's reconciled rows, which keep their
// identity across unchanged rescans, so a focus refresh costs no copy and no write.
const lastSavedRows = new Map<string, readonly AiVaultSession[]>()

function database(): Promise<IDBDatabase> {
  connection ??= indexedDbConnection(indexedDB, DATABASE_NAME, DATABASE_VERSION, (db) => {
    if (!db.objectStoreNames.contains(LISTS)) {
      db.createObjectStore(LISTS).createIndex(SAVED_AT, SAVED_AT)
    }
  })
  return connection()
}

// Rows keep only what the list shows: the latest turn, not the conversation or prompts.
function savedRow(session: AiVaultSession): AiVaultSession {
  const {
    previewMessages: _previewMessages,
    previewMessagesTruncated: _previewMessagesTruncated,
    firstUserPrompt: _firstUserPrompt,
    lastUserPrompt: _lastUserPrompt,
    antigravityOpeningPrompt: _antigravityOpeningPrompt,
    ...row
  } = session
  const latest = latestSessionConversationTurn(session)
  // Truncated so first-prompt readers never take the latest turn for the opening ask.
  return latest
    ? { ...row, previewMessages: [latest], previewMessagesTruncated: true }
    : { ...row, previewMessages: [] }
}

function isStoredList(value: unknown): value is StoredList {
  return (
    typeof value === 'object' &&
    value !== null &&
    'format' in value &&
    value.format === ROW_FORMAT &&
    'savedAt' in value &&
    typeof value.savedAt === 'number' &&
    'limit' in value &&
    (value.limit === 'unlimited' || typeof value.limit === 'number') &&
    'sessions' in value &&
    Array.isArray(value.sessions)
  )
}

export async function readSavedAiVaultSessionList(
  key: string
): Promise<SavedAiVaultSessionList | null> {
  const stored = storageKey(key)
  if (!stored) {
    return null
  }
  try {
    const value: unknown = await settledRequest(
      (await database()).transaction(LISTS, 'readonly').objectStore(LISTS).get(stored)
    )
    if (!isStoredList(value)) {
      return null
    }
    const scannedAt = new Date(value.savedAt).toISOString()
    return { limit: value.limit, result: { sessions: value.sessions, issues: [], scannedAt } }
  } catch {
    return null
  }
}

export async function saveAiVaultSessionList(
  key: string,
  limit: AiVaultSessionLimit,
  result: AiVaultListResult
): Promise<void> {
  const stored = storageKey(key)
  if (!stored || lastSavedRows.get(stored) === result.sessions) {
    return
  }
  // Host lists are newest first, so the cut keeps the rows the panel opens on.
  const list: StoredList = {
    format: ROW_FORMAT,
    savedAt: Date.now(),
    // A cut list covers no deeper than its rows.
    limit:
      result.sessions.length > MAX_SAVED_ROWS && (limit === 'unlimited' || limit > MAX_SAVED_ROWS)
        ? MAX_SAVED_ROWS
        : limit,
    sessions: result.sessions.slice(0, MAX_SAVED_ROWS).map(savedRow)
  }
  try {
    const transaction = (await database()).transaction(LISTS, 'readwrite')
    const done = committedTransaction(transaction)
    const lists = transaction.objectStore(LISTS)
    lists.put(list, stored)
    // Oldest first: the index orders keys by save time.
    const keys = lists.index(SAVED_AT).getAllKeys()
    keys.onsuccess = () => {
      const excess = Math.max(0, keys.result.length - MAX_SAVED_LISTS)
      for (const oldest of keys.result.slice(0, excess)) {
        lists.delete(oldest)
        // Evicted keys must write again, even when their rows haven't changed.
        lastSavedRows.delete(String(oldest))
      }
      transaction.commit?.()
    }
    await done
    lastSavedRows.set(stored, result.sessions)
  } catch {
    // A refused write only costs the next restart its instant list; the next scan tries again.
  }
}

/** Drops a deleted session from every saved list so no scope repaints it before its rescan. */
export async function forgetSavedAiVaultSession(sessionId: string): Promise<void> {
  if (!savedListsAvailable()) {
    return
  }
  // Whatever lists held the row are rewritten, so the next scan of each scope saves again.
  lastSavedRows.clear()
  try {
    const transaction = (await database()).transaction(LISTS, 'readwrite')
    const done = committedTransaction(transaction)
    const cursorRequest = transaction.objectStore(LISTS).openCursor()
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result
      if (!cursor) {
        return
      }
      const value: unknown = cursor.value
      if (isStoredList(value) && value.sessions.some((session) => session.id === sessionId)) {
        cursor.update({
          ...value,
          sessions: value.sessions.filter((session) => session.id !== sessionId)
        })
      }
      cursor.continue()
    }
    await done
  } catch {
    // The next rescan of each scope drops the row anyway.
  }
}
