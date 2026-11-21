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
const NOTE_TEXT_MAX = 2000

const entries = new Map<string, NativeChatAttachmentNotes>()
const listeners = new Set<() => void>()
let loaded = false

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

function load(): void {
  if (loaded) {
    return
  }
  loaded = true
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    if (Array.isArray(parsed)) {
      for (const entry of parsed) {
        if (Array.isArray(entry) && typeof entry[0] === 'string' && isNotes(entry[1])) {
          entries.set(entry[0], entry[1])
        }
      }
    }
  } catch {
    // Unreadable storage only costs remembered notes; the marked image itself stays in the draft.
  }
}

function save(): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify([...entries]))
  } catch {
    // Quota or blocked storage: the notes still work for this session.
  }
}

function changed(): void {
  save()
  for (const listener of listeners) {
    listener()
  }
}

export function readNativeChatAttachmentNotes(
  scopeKey: string,
  attachmentId: string
): NativeChatAttachmentNotes | null {
  load()
  return entries.get(keyOf(scopeKey, attachmentId)) ?? null
}

export function setNativeChatAttachmentNotes(
  scopeKey: string,
  attachmentId: string,
  value: NativeChatAttachmentNotes
): void {
  load()
  const key = keyOf(scopeKey, attachmentId)
  entries.delete(key)
  entries.set(key, {
    ...value,
    notes: value.notes.map((note) => ({ ...note, text: note.text.slice(0, NOTE_TEXT_MAX) }))
  })
  // Over the cap, notes whose image left its draft go first, oldest first; notes on an image still
  // in a draft are never dropped.
  for (const stale of entries.keys()) {
    if (entries.size <= NATIVE_CHAT_ATTACHMENT_NOTES_MAX) {
      break
    }
    const [scope, id] = stale.split('\u0000')
    if (!readNativeChatComposerDraft(scope ?? '').images.some((image) => image.id === id)) {
      entries.delete(stale)
    }
  }
  changed()
}

/** Also ends the chat's notes line: once notes are sent or taken out, its Undo no longer applies. */
export function clearNativeChatAttachmentNotes(
  scopeKey: string,
  attachmentIds: readonly string[]
): void {
  dismissNativeChatNotesNotice(scopeKey)
  load()
  let removed = false
  for (const id of attachmentIds) {
    removed = entries.delete(keyOf(scopeKey, id)) || removed
  }
  if (removed) {
    changed()
  }
}

/** Drops notes for scopes whose drafts are deleted, such as a closed chat or removed workspace. */
export function clearNativeChatAttachmentNotesWhere(matches: (scopeKey: string) => boolean): void {
  load()
  let removed = false
  for (const key of entries.keys()) {
    if (matches(key.slice(0, key.indexOf('\u0000')))) {
      entries.delete(key)
      removed = true
    }
  }
  if (removed) {
    changed()
  }
}

/** Notes for the images a draft holds, so chips can show their count. */
export function useNativeChatAttachmentNotes(
  scopeKey: string,
  attachmentId: string
): NativeChatAttachmentNotes | null {
  return useSyncExternalStore(subscribeToNativeChatAttachmentNotes, () =>
    readNativeChatAttachmentNotes(scopeKey, attachmentId)
  )
}

function subscribeToNativeChatAttachmentNotes(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
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
  entries.clear()
  listeners.clear()
  loaded = false
}
