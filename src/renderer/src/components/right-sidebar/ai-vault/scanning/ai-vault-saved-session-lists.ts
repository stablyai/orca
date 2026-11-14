// Last list per scope, kept across restarts so History can paint it while the rescan runs.

import { latestSessionConversationTurn } from '../../../../../../shared/ai-vault/session-display/ai-vault-session-display'
import { useAppStore } from '@/store/index'
import { isWebClientLocation } from '@/app-shell/platform/web-client-location'
import {
  committedTransaction,
  indexedDbConnection,
  settledRequest
} from '@/app-shell/storage/indexeddb-connection'
import { catalogRowsEqual } from '@/lib/catalog-reconciliation/catalog-row-reconciliation'
import type {
  AiVaultListResult,
  AiVaultSession
} from '../../../../../../shared/ai-vault/contracts/ai-vault-types'
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
// Past this the scan has usually answered, and a saved list arriving later is dropped anyway.
const PROFILE_WAIT_MS = 5_000

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
function storageKey(
  key: string,
  profileId = useAppStore.getState().activeOrcaProfileId
): string | null {
  return savedListsAvailable() && profileId ? JSON.stringify([profileId, key]) : null
}

// After a restart the panel can mount, and even finish a scan, before startup has loaded the profile list.
function loadedProfileId(): Promise<string | null> {
  const current = useAppStore.getState().activeOrcaProfileId
  if (current || !savedListsAvailable()) {
    return Promise.resolve(current)
  }
  return new Promise((resolve) => {
    const finish = (profileId: string | null) => {
      clearTimeout(timer)
      unsubscribe()
      resolve(profileId)
    }
    const timer = setTimeout(() => finish(null), PROFILE_WAIT_MS)
    const unsubscribe = useAppStore.subscribe((state) => {
      if (state.activeOrcaProfileId) {
        finish(state.activeOrcaProfileId)
      }
    })
  })
}

let connection: (() => Promise<IDBDatabase>) | null = null
// What each stored key last wrote, so a rescan that changed nothing (every focus refresh) skips the
// copy and the write. Only the saved rows are kept, never the whole list.
const lastSaved = new Map<string, { limit: AiVaultSessionLimit; rows: readonly AiVaultSession[] }>()
// Save order this run. A skipped save still counts as use, so eviction stays least recently shown.
const lastUse = new Map<string, number>()
let uses = 0

function unchangedSinceSave(
  stored: string,
  limit: AiVaultSessionLimit,
  rows: readonly AiVaultSession[]
): boolean {
  const last = lastSaved.get(stored)
  if (!last || last.limit !== limit) {
    return false
  }
  // The panel's rows keep their identity across unchanged rescans, so this is usually a pointer walk.
  if (last.rows.length === rows.length && last.rows.every((row, index) => row === rows[index])) {
    return true
  }
  // A remount or a return to this scope brings fresh copies; comparing them costs far less than a write.
  if (!catalogRowsEqual(last.rows, rows)) {
    return false
  }
  lastSaved.set(stored, { limit, rows })
  return true
}

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
  // Marked truncated, as the row contract asks, because the opening ask is no longer in the window.
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
  const stored = storageKey(key, await loadedProfileId())
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
  const stored = storageKey(key, await loadedProfileId())
  if (!stored) {
    return
  }
  // Host lists are newest first, so the cut keeps the rows the panel opens on.
  const rows = result.sessions.slice(0, MAX_SAVED_ROWS)
  // A cut list covers no deeper than its rows.
  const savedLimit =
    result.sessions.length > MAX_SAVED_ROWS && (limit === 'unlimited' || limit > MAX_SAVED_ROWS)
      ? MAX_SAVED_ROWS
      : limit
  lastUse.set(stored, ++uses)
  if (unchangedSinceSave(stored, savedLimit, rows)) {
    return
  }
  const list: StoredList = {
    format: ROW_FORMAT,
    savedAt: Date.now(),
    limit: savedLimit,
    sessions: rows.map(savedRow)
  }
  try {
    const transaction = (await database()).transaction(LISTS, 'readwrite')
    const done = committedTransaction(transaction)
    const lists = transaction.objectStore(LISTS)
    lists.put(list, stored)
    // The index orders keys by write time; the stable sort then puts this run's uses last, in order.
    const keys = lists.index(SAVED_AT).getAllKeys()
    keys.onsuccess = () => {
      const byUse = keys.result
        .map(String)
        .sort((a, b) => (lastUse.get(a) ?? 0) - (lastUse.get(b) ?? 0))
      for (const oldest of byUse.slice(0, Math.max(0, byUse.length - MAX_SAVED_LISTS))) {
        lists.delete(oldest)
        // Evicted keys must write again, even when their rows haven't changed.
        lastSaved.delete(oldest)
        lastUse.delete(oldest)
      }
      transaction.commit?.()
    }
    await done
    lastSaved.set(stored, { limit: savedLimit, rows })
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
  lastSaved.clear()
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
