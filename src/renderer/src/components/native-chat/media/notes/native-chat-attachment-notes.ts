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
import { releaseHeldNativeChatNotesHandedTo } from './native-chat-held-notes'
import { readNativeChatComposerDraft } from '../../drafts/native-chat-composer-draft-store'
import { currentDraftScope } from '../../drafts/native-chat-launch-draft-source'
import {
  isNativeChatEditDraft,
  load as draftLoad
} from '../../drafts/native-chat-composer-draft-memory'
import {
  captureNativeChatNotesEntries,
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

// Keyed where the draft is now, as its images are read: notes saved while a launch draft became its
// session's land with that draft, not under the scope it left.
const keyOf = (scopeKey: string, attachmentId: string): string =>
  `${currentDraftScope(scopeKey)}\u0000${attachmentId}`

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

// Attachment ids are unique, so notes found under another scope for an image this draft holds are
// its own, left behind by a move whose copy storage refused (and that a restart cut short). They
// are read from there and adopted: copied under this draft's own key once storage takes it, after
// which the scope they were left in lets go of them (see the draft move).
const adoptions = new Map<string, string>()
let adoptionQueued = false
let onAdopted: (from: string, to: string, attachmentId: string) => void = () => {}

/** Sets what happens once notes left under another scope are saved under their draft's own. */
export function setNativeChatAttachmentNotesAdoption(
  next: (from: string, to: string, attachmentId: string) => void
): void {
  onAdopted = next
}

/** Adopts notes left under another scope wherever storage now takes them; retried on later saves. */
export function retryNativeChatAttachmentNotesAdoption(): void {
  if (!nativeChatComposerDraftsHydrated()) {
    return
  }
  const scopeOf = (key: string): string => key.slice(0, key.indexOf('\u0000'))
  const idOf = (key: string): string => key.slice(key.indexOf('\u0000') + 1)
  for (const [own, left] of adoptions) {
    const entry = storage.get(left)
    // Removed from its draft meanwhile: nothing to adopt for it any more.
    const held = readNativeChatComposerDraft(scopeOf(own)).images.some(({ id }) => id === idOf(own))
    if (!entry || !held) {
      adoptions.delete(own)
      // An earlier, refused attempt would otherwise land with the next save.
      if (!held && storage.get(own)) {
        storage.update((entries) => entries.delete(own))
      }
      continue
    }
    // Copied already but refused: only a save that lands counts.
    const saved = storage.get(own)
      ? storage.save()
      : storage.update((entries) => entries.set(own, entry).has(own))
    if (!saved) {
      continue
    }
    adoptions.delete(own)
    onAdopted(scopeOf(left), scopeOf(own), idOf(own))
  }
}

function leftElsewhere(
  scopeKey: string,
  own: string,
  attachmentId: string
): NativeChatAttachmentNotes | null {
  const suffix = `\u0000${attachmentId}`
  // The most recently written copy, should several scopes hold one.
  const left = storage.keys().findLast((key) => key !== own && key.endsWith(suffix))
  if (!left) {
    return null
  }
  // A queued edit copies a message's images without moving its draft: it reads their notes, but
  // never takes them over.
  if (!adoptions.has(own) && !isNativeChatEditDraft(scopeKey)) {
    adoptions.set(own, left)
    if (!adoptionQueued) {
      adoptionQueued = true
      queueMicrotask(() => {
        adoptionQueued = false
        retryNativeChatAttachmentNotesAdoption()
      })
    }
  }
  return storage.get(left) ?? null
}

/** Whether `to` has saved, under its own key, the very notes `from` holds for this image (true when
 *  `from` holds none). A copy storage refused is in this window alone and goes with it, and an
 *  older entry of `to` under the same image may hold other words: neither lets `from` let go. */
export function nativeChatAttachmentNotesSavedAt(
  from: string,
  to: string,
  attachmentId: string
): boolean {
  const donor = storage.get(keyOf(from, attachmentId))
  if (!donor) {
    return true
  }
  const own = keyOf(to, attachmentId)
  const copy = storage.get(own)
  return (
    copy !== undefined &&
    storage.saved(own) &&
    JSON.stringify(copy.notes) === JSON.stringify(donor.notes)
  )
}

export function readNativeChatAttachmentNotes(
  scopeKey: string,
  attachmentId: string
): NativeChatAttachmentNotes | null {
  const own = keyOf(scopeKey, attachmentId)
  const saved = storage.get(own)
  if (saved) {
    return saved
  }
  // Only for an image this chat's draft holds: another chat never reads notes that aren't its own.
  return readNativeChatComposerDraft(scopeKey).images.some(({ id }) => id === attachmentId)
    ? leftElsewhere(scopeKey, own, attachmentId)
    : null
}

export function setNativeChatAttachmentNotes(
  scopeKey: string,
  attachmentId: string,
  value: NativeChatAttachmentNotes
): boolean {
  return storage.update((entries) => {
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

/** Also ends the chat's notes line (unless `endsNotice` is false): once notes are sent or taken out,
 *  its Undo no longer applies. */
export function clearNativeChatAttachmentNotes(
  scopeKey: string,
  attachmentIds: readonly string[],
  endsNotice = true
): void {
  if (endsNotice) {
    dismissNativeChatNotesNotice(scopeKey)
  }
  releaseHeldNativeChatNotesHandedTo(scopeKey, attachmentIds)
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

/** Notes follow their draft when it moves to another scope (a launch draft becoming a session's).
 *  With `keepSource` they are copied: the source's go only when its draft is gone for good. */
export function moveNativeChatAttachmentNotes(
  from: string,
  to: string,
  keepSource = false
): boolean {
  return storage.update((entries) =>
    moveNativeChatNotesEntries(entries, from, to, undefined, keepSource)
  )
}

/** This scope's notes as they are now, and what removes exactly those later (see the draft move). */
export function captureNativeChatAttachmentNotes(scopeKey: string): () => void {
  return captureNativeChatNotesEntries(storage, scopeKey)
}

// What hand-overs storage refused let go of once the moved notes are saved.
const releaseWhenSaved: (() => void)[] = []

/** Retries notes writes storage refused; true once storage holds them all. */
export function saveNativeChatAttachmentNotes(): boolean {
  if (!storage.save()) {
    return false
  }
  for (const release of releaseWhenSaved.splice(0)) {
    release()
  }
  return true
}

/** Moves `from`'s notes to `to`, keeping `from`'s saved copies until `to`'s are saved: when storage
 *  refuses the move, the only saved words stay where `to`'s images still find them (see
 *  `readNativeChatAttachmentNotes`), let go of at a later save. True once the move is saved. */
export function handOverNativeChatAttachmentNotes(from: string, to: string): boolean {
  const release = captureNativeChatAttachmentNotes(from)
  if (moveNativeChatAttachmentNotes(from, to, true)) {
    release()
    return true
  }
  releaseWhenSaved.push(release)
  return false
}

/** A command takes no notes and none of their images: the draft's marked images, with their notes,
 *  stay in the message box for the next message while `clear` removes the rest in the same write. */
export function clearNativeChatImagesKeepingNoted(
  scopeKey: string,
  clear: (keep: readonly string[]) => void
): void {
  clear(
    readNativeChatComposerDraft(scopeKey)
      .images.filter(({ id }) => readNativeChatAttachmentNotes(scopeKey, id) !== null)
      .map(({ id }) => id)
  )
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
  releaseWhenSaved.length = 0
  storage.resetForTests()
}
