// Notes travel with the marked image they were drawn on: the image attachment is their one owner,
// so removing the chip removes them and sending the image sends them. Small and bounded, so
// localStorage keeps them across reloads beside the draft that holds the image.

import { useSyncExternalStore } from 'react'
import {
  nativeChatNotesText,
  nativeChatNoteTimesNeedTenths,
  type NativeChatMediaNote
} from './native-chat-media-notes'
import { dismissNativeChatNotesNotice } from './native-chat-notes-notice'
import { readNativeChatComposerDraft } from '../../drafts/native-chat-composer-draft-store'
import { load as draftLoad } from '../../drafts/native-chat-composer-draft-memory'
import {
  createNativeChatNotesStorage,
  moveNativeChatNotesEntries
} from './native-chat-notes-storage'

const nativeChatComposerDraftsHydrated = (): boolean => draftLoad.hydrated

/** The media the notes were made on, so reopening the chip edits them on the original. */
export type NativeChatNotesSource = { path?: string; url?: string; connectionId?: string }

export type NativeChatAttachmentNotes = {
  mediaName: string
  source: NativeChatNotesSource
  kind: 'image' | 'video'
  notes: readonly NativeChatMediaNote[]
  /** Marks already drawn into a sent copy these notes continue after. */
  offset: number
}

const STORAGE_KEY = 'orca.nativeChat.attachmentNotes.v1'
/** Marked images remembered at once; older ones are dropped first. */
export const NATIVE_CHAT_ATTACHMENT_NOTES_MAX = 60

const keyOf = (scopeKey: string, attachmentId: string): string => `${scopeKey}\u0000${attachmentId}`

function isNotes(value: unknown): value is NativeChatAttachmentNotes {
  return (
    typeof value === 'object' &&
    value !== null &&
    'mediaName' in value &&
    typeof value.mediaName === 'string' &&
    'notes' in value &&
    Array.isArray(value.notes) &&
    'offset' in value &&
    typeof value.offset === 'number'
  )
}

const storage = createNativeChatNotesStorage<NativeChatAttachmentNotes>(STORAGE_KEY, (value) =>
  isNotes(value) ? value : null
)

export function readNativeChatAttachmentNotes(
  scopeKey: string,
  attachmentId: string
): NativeChatAttachmentNotes | null {
  return storage.get(keyOf(scopeKey, attachmentId)) ?? null
}

export function setNativeChatAttachmentNotes(
  scopeKey: string,
  attachmentId: string,
  value: NativeChatAttachmentNotes
): void {
  storage.update((entries) => {
    const key = keyOf(scopeKey, attachmentId)
    entries.delete(key)
    entries.set(key, value)
    // Over the cap, notes whose image left its draft go first, oldest first; notes on an image still
    // in a draft are never dropped. Until saved drafts are loaded, no image is known to have left.
    if (!nativeChatComposerDraftsHydrated()) {
      return true
    }
    for (const stale of entries.keys()) {
      if (entries.size <= NATIVE_CHAT_ATTACHMENT_NOTES_MAX) {
        break
      }
      const [scope, id] = stale.split('\u0000')
      if (!readNativeChatComposerDraft(scope ?? '').images.some((image) => image.id === id)) {
        entries.delete(stale)
      }
    }
    return true
  })
}

/** Also ends the chat's notes line: once notes are sent or taken out, its Undo no longer applies. */
export function clearNativeChatAttachmentNotes(
  scopeKey: string,
  attachmentIds: readonly string[]
): void {
  dismissNativeChatNotesNotice(scopeKey)
  storage.update((entries) => {
    let removed = false
    for (const id of attachmentIds) {
      removed = entries.delete(keyOf(scopeKey, id)) || removed
    }
    return removed
  })
}

/** Drops notes for scopes whose drafts are deleted, such as a closed chat or removed workspace. */
export function clearNativeChatAttachmentNotesWhere(matches: (scopeKey: string) => boolean): void {
  storage.update((entries) => {
    let removed = false
    for (const key of entries.keys()) {
      if (matches(key.slice(0, key.indexOf('\u0000')))) {
        entries.delete(key)
        removed = true
      }
    }
    return removed
  })
}

/** Notes follow their draft when it moves to another scope (a launch draft becoming a session's). */
export function moveNativeChatAttachmentNotes(from: string, to: string): void {
  storage.update((entries) => moveNativeChatNotesEntries(entries, from, to))
}

/** Notes for the images a draft holds, so chips can show their count. */
export function useNativeChatAttachmentNotes(
  scopeKey: string,
  attachmentId: string
): NativeChatAttachmentNotes | null {
  return useSyncExternalStore(storage.subscribe, () =>
    readNativeChatAttachmentNotes(scopeKey, attachmentId)
  )
}

/** The sent text with each marked image's notes after it, in attachment order. */
export function withNativeChatAttachmentNotes(
  text: string,
  scopeKey: string,
  attachmentIds: readonly string[]
): string {
  const blocks = attachmentIds.flatMap((id) => {
    const entry = readNativeChatAttachmentNotes(scopeKey, id)
    if (!entry || entry.notes.length === 0) {
      return []
    }
    return [
      nativeChatNotesText(entry.mediaName, entry.notes, nativeChatNoteTimesNeedTenths(entry.notes))
    ]
  })
  if (blocks.length === 0) {
    return text
  }
  // Only trailing space goes: a leading one is the user's and decides how the text is sent.
  return [text.trimEnd(), ...blocks].filter(Boolean).join('\n\n')
}

/** Test-only. */
export function resetNativeChatAttachmentNotesForTests(): void {
  storage.resetForTests()
}
