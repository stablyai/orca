import { useSyncExternalStore } from 'react'
import type { NativeChatMediaNote } from './native-chat-media-notes'
import type { NativeChatNotesSource } from './native-chat-attachment-notes'
import { nativeChatComposerDraftSaved } from '../../drafts/native-chat-composer-draft-saved'
import {
  createNativeChatNotesStorage,
  moveNativeChatNotesEntries
} from './native-chat-notes-storage'

// Notes a closed viewer could not hand to the message box (it held a command), kept with their chat
// and media so reopening that media brings them back, across reloads too. They are never sent from
// here, and leave only once a viewer hands them to the message box or all of them are removed, or
// the chat's draft is deleted. Bounded: oldest dropped first.

const STORAGE_KEY = 'orca.nativeChat.heldNotes.v1'
export const NATIVE_CHAT_HELD_NOTES_MAX = 60

/** `hold`: which hold this is, so a viewer ends only the hold it opened, never a newer one. */
type HeldEntry = { scopeKey: string; notes: readonly NativeChatMediaNote[]; hold?: string }

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
  isHeldEntry(value)
    ? {
        scopeKey: value.scopeKey,
        notes: value.notes,
        ...('hold' in value && typeof value.hold === 'string' ? { hold: value.hold } : {})
      }
    : null
)

let holdSequence = 0
const nextHold = (): string => `hold-${Date.now().toString(36)}-${(holdSequence += 1)}`

export function holdNativeChatNotes(
  scopeKey: string,
  mediaKey: string,
  notes: readonly NativeChatMediaNote[]
): boolean {
  return storage.update((held) => {
    const key = keyOf(scopeKey, mediaKey)
    held.delete(key)
    held.set(key, { scopeKey, notes, hold: nextHold() })
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

/** The notes held for this media in this chat. They stay held while a viewer edits them, so a
 *  restart before the edit is handed off or held again still finds them. */
export function readHeldNativeChatNotes(
  scopeKey: string,
  mediaKey: string
): readonly NativeChatMediaNote[] | null {
  return storage.get(keyOf(scopeKey, mediaKey))?.notes ?? null
}

/** The hold a viewer read back: it ends that one only, never a newer one held from another viewer. */
export type NativeChatHeldNotesClaim = { scopeKey: string; mediaKey: string; hold: string }

export function claimHeldNativeChatNotes(
  scopeKey: string,
  mediaKey: string
): NativeChatHeldNotesClaim {
  return { scopeKey, mediaKey, hold: storage.get(keyOf(scopeKey, mediaKey))?.hold ?? '' }
}

/** Ends the claimed hold, once its notes are deliberately removed, while it is still that hold. */
export function releaseHeldNativeChatNotes(claim: NativeChatHeldNotesClaim): void {
  storage.update((held) => {
    const key = keyOf(claim.scopeKey, claim.mediaKey)
    const entry = held.get(key)
    return entry !== undefined && (entry.hold ?? '') === claim.hold && held.delete(key)
  })
}

/** Ends the claimed hold once its notes were handed to the message box and the chat's draft holding
 *  them is saved; a refused draft write keeps the hold, so a restart still finds the notes. */
export function releaseHeldNativeChatNotesOnceSaved(
  claim: NativeChatHeldNotesClaim
): Promise<void> {
  return nativeChatComposerDraftSaved(claim.scopeKey).then((saved) => {
    if (saved) {
      releaseHeldNativeChatNotes(claim)
    }
  })
}

/** Retries held-notes writes storage refused; true once storage holds them all. */
export function saveNativeChatHeldNotes(): boolean {
  return storage.save()
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

/** Held notes follow their chat's draft when it moves to another scope. Where that chat already
 *  holds notes for the same media, both sets stay: the moved notes go after its own, numbered on. */
export function moveNativeChatHeldNotes(from: string, to: string, keepSource = false): boolean {
  return storage.update((held) =>
    moveNativeChatNotesEntries(
      held,
      from,
      to,
      (entry) => ({ ...entry, scopeKey: to }),
      keepSource,
      combineHeldNotes
    )
  )
}

function combineHeldNotes(existing: HeldEntry, moved: HeldEntry): HeldEntry {
  const kept = new Set(existing.notes.map(({ id }) => id))
  // A copy moved again brings nothing new.
  const added = moved.notes.filter(({ id }) => !kept.has(id))
  if (added.length === 0) {
    return existing
  }
  const last = existing.notes.reduce((max, note) => Math.max(max, note.number), 0)
  // A new hold: a viewer that read the destination's own notes must not end the merged set.
  return {
    ...existing,
    hold: nextHold(),
    notes: [
      ...existing.notes,
      ...added.map((note, index) => ({ ...note, number: last + index + 1 }))
    ]
  }
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
