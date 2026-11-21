import { useSyncExternalStore } from 'react'
import type { NativeChatMediaNote } from './native-chat-media-notes'

// Notes a closed viewer could not hand to the message box (it held a command), kept with their chat
// and media so reopening that media brings them back, across reloads too. They are never sent from
// here, and leave only when the viewer takes them back or the chat's draft is deleted. Bounded:
// oldest dropped first.

const STORAGE_KEY = 'orca.nativeChat.heldNotes.v1'
export const NATIVE_CHAT_HELD_NOTES_MAX = 60
const NOTE_TEXT_MAX = 2000

type HeldEntry = { scopeKey: string; notes: readonly NativeChatMediaNote[] }
const held = new Map<string, HeldEntry>()
let loaded = false
const listeners = new Set<() => void>()

const keyOf = (scopeKey: string, mediaKey: string): string => `${scopeKey}\0${mediaKey}`

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

function load(): void {
  if (loaded) {
    return
  }
  loaded = true
  try {
    const entries: unknown = JSON.parse(globalThis.localStorage?.getItem(STORAGE_KEY) ?? '[]')
    for (const entry of Array.isArray(entries) ? entries : []) {
      if (
        Array.isArray(entry) &&
        typeof entry[0] === 'string' &&
        typeof entry[1]?.scopeKey === 'string' &&
        Array.isArray(entry[1]?.notes) &&
        entry[1].notes.every(isNote)
      ) {
        held.set(entry[0], { scopeKey: entry[1].scopeKey, notes: entry[1].notes })
      }
    }
  } catch {
    // Unreadable storage only costs held notes from an earlier session.
  }
}

function save(): void {
  for (const listener of listeners) {
    listener()
  }
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify([...held]))
  } catch {
    // Quota or blocked storage: the notes are still held for this session.
  }
}

export function holdNativeChatNotes(
  scopeKey: string,
  mediaKey: string,
  notes: readonly NativeChatMediaNote[]
): void {
  load()
  const key = keyOf(scopeKey, mediaKey)
  held.delete(key)
  held.set(key, {
    scopeKey,
    notes: notes.map((note) => ({ ...note, text: note.text.slice(0, NOTE_TEXT_MAX) }))
  })
  while (held.size > NATIVE_CHAT_HELD_NOTES_MAX) {
    const oldest = held.keys().next().value
    if (oldest === undefined) {
      break
    }
    held.delete(oldest)
  }
  save()
}

/** The notes held for this media in this chat, removed from the hold as the viewer takes them back. */
export function takeHeldNativeChatNotes(
  scopeKey: string,
  mediaKey: string
): readonly NativeChatMediaNote[] | null {
  load()
  const key = keyOf(scopeKey, mediaKey)
  const entry = held.get(key)
  if (!entry) {
    return null
  }
  held.delete(key)
  save()
  return entry.notes
}

/** Drops held notes whose chat draft is deleted, such as a closed chat or a removed workspace. */
export function clearNativeChatHeldNotesWhere(matches: (scopeKey: string) => boolean): void {
  load()
  let changed = false
  for (const [key, entry] of held) {
    if (matches(entry.scopeKey)) {
      held.delete(key)
      changed = true
    }
  }
  if (changed) {
    save()
  }
}

function subscribeToHeldNotes(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** How many notes this chat holds for this media, for the "Notes kept" mark on its tile. */
export function useNativeChatHeldNotesCount(
  scopeKey: string | undefined,
  mediaKey: string | undefined
): number {
  return useSyncExternalStore(subscribeToHeldNotes, () => {
    if (!scopeKey || !mediaKey) {
      return 0
    }
    load()
    return held.get(keyOf(scopeKey, mediaKey))?.notes.length ?? 0
  })
}

/** Test-only: forget held notes and reload from storage on next read. */
export function resetNativeChatHeldNotesForTests(): void {
  held.clear()
  loaded = false
}
