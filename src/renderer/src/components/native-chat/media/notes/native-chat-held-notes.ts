import { useSyncExternalStore } from 'react'
import type { NativeChatMediaNote } from './native-chat-media-notes'
import type { NativeChatNotesSource } from './native-chat-attachment-notes'
import {
  createNativeChatNotesStorage,
  moveNativeChatNotesEntries
} from './native-chat-notes-storage'

// Notes a closed viewer could not hand to the message box (it held a command), kept with their chat
// and media so reopening that media brings them back, across reloads too. They are never sent from
// here, and leave only when the viewer takes them back or the chat's draft is deleted. Bounded:
// oldest dropped first.

const STORAGE_KEY = 'orca.nativeChat.heldNotes.v1'
export const NATIVE_CHAT_HELD_NOTES_MAX = 60

type HeldEntry = { scopeKey: string; notes: readonly NativeChatMediaNote[] }

const keyOf = (scopeKey: string, mediaKey: string): string => `${scopeKey}\0${mediaKey}`

/** Which media held notes belong to: the same path on another connection is another file. */
export function nativeChatNotesMediaKey(source: NativeChatNotesSource, fallback = ''): string {
  if (source.path) {
    return source.connectionId ? `${source.connectionId}\0${source.path}` : source.path
  }
  return source.url ?? fallback
}

function isNote(value: unknown): value is NativeChatMediaNote {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    typeof value.id === 'string' &&
    'number' in value &&
    typeof value.number === 'number' &&
    'text' in value &&
    typeof value.text === 'string' &&
    'mark' in value &&
    typeof value.mark === 'object' &&
    value.mark !== null
  )
}

function isHeldEntry(value: unknown): value is HeldEntry {
  return (
    typeof value === 'object' &&
    value !== null &&
    'scopeKey' in value &&
    typeof value.scopeKey === 'string' &&
    'notes' in value &&
    Array.isArray(value.notes) &&
    value.notes.every(isNote)
  )
}

const storage = createNativeChatNotesStorage<HeldEntry>(STORAGE_KEY, (value) =>
  isHeldEntry(value) ? { scopeKey: value.scopeKey, notes: value.notes } : null
)

export function holdNativeChatNotes(
  scopeKey: string,
  mediaKey: string,
  notes: readonly NativeChatMediaNote[]
): void {
  storage.update((held) => {
    const key = keyOf(scopeKey, mediaKey)
    held.delete(key)
    held.set(key, { scopeKey, notes })
    while (held.size > NATIVE_CHAT_HELD_NOTES_MAX) {
      const oldest = held.keys().next().value
      if (oldest === undefined) {
        break
      }
      held.delete(oldest)
    }
    return true
  })
}

/** The notes held for this media in this chat, removed from the hold as the viewer takes them back. */
export function takeHeldNativeChatNotes(
  scopeKey: string,
  mediaKey: string
): readonly NativeChatMediaNote[] | null {
  const key = keyOf(scopeKey, mediaKey)
  let taken: readonly NativeChatMediaNote[] | null = null
  storage.update((held) => {
    taken = held.get(key)?.notes ?? null
    return held.delete(key)
  })
  return taken
}

/** Drops held notes whose chat draft is deleted, such as a closed chat or a removed workspace. */
export function clearNativeChatHeldNotesWhere(matches: (scopeKey: string) => boolean): void {
  storage.update((held) => {
    let changed = false
    for (const [key, entry] of held) {
      if (matches(entry.scopeKey)) {
        held.delete(key)
        changed = true
      }
    }
    return changed
  })
}

/** Held notes follow their chat's draft when it moves to another scope. */
export function moveNativeChatHeldNotes(from: string, to: string): void {
  storage.update((held) =>
    moveNativeChatNotesEntries(held, from, to, (entry) => ({ ...entry, scopeKey: to }))
  )
}

/** How many notes this chat holds for this media, for the "Notes kept" mark on its tile. */
export function useNativeChatHeldNotesCount(
  scopeKey: string | undefined,
  mediaKey: string | undefined
): number {
  return useSyncExternalStore(storage.subscribe, () =>
    scopeKey && mediaKey ? (storage.get(keyOf(scopeKey, mediaKey))?.notes.length ?? 0) : 0
  )
}

/** Test-only: forget held notes and reload from storage on next read. */
export function resetNativeChatHeldNotesForTests(): void {
  storage.resetForTests()
}
