import { useEffect, useState } from 'react'
import {
  loadLocalImageSrc,
  useLocalImageSrc
} from '@/components/editor/document-images/useLocalImageSrc'
import { chatImageAccess } from '@/lib/files/access/local-file-access'
import { removeImageWithReferences } from '../../composer/editor/native-chat-composer-image-references'
import { whenNativeChatComposerDraftSaved } from '../../drafts/native-chat-composer-draft-saved'
import {
  appendToNativeChatComposerDraft,
  readNativeChatComposerDraft
} from '../../drafts/native-chat-composer-draft-store'
import {
  clearNativeChatAttachmentNotes,
  readNativeChatAttachmentNotes,
  setNativeChatAttachmentNotes,
  type NativeChatAttachmentNotes
} from './native-chat-attachment-notes'

const inDraft = (scopeKey: string, id: string): boolean =>
  readNativeChatComposerDraft(scopeKey).images.some((entry) => entry.id === id)

/** Takes an image out of the draft and its notes with it, returning what puts both back as they were
 *  (false when the notes couldn't be saved). With `keepNotesUntilSaved` (a marked copy replaces it),
 *  its notes stay saved until the draft without it is, so a restart before then recovers it whole. */
export function takeNativeChatNotedImage(
  scopeKey: string,
  id: string,
  keepNotesUntilSaved = false
): () => boolean {
  const image = readNativeChatComposerDraft(scopeKey).images.find((entry) => entry.id === id)
  const notes = readNativeChatAttachmentNotes(scopeKey, id)
  removeImageWithReferences(scopeKey, null, id)
  if (keepNotesUntilSaved) {
    // Retried at later saves while this one is refused; Undo putting the image back ends the wait.
    whenNativeChatComposerDraftSaved(scopeKey, () => {
      if (!inDraft(scopeKey, id)) {
        clearNativeChatAttachmentNotes(scopeKey, [id], false)
      }
    })
  } else {
    clearNativeChatAttachmentNotes(scopeKey, [id])
  }
  return () => {
    // Back in the draft durably (saved or journaled) and its notes saved, or this reports false.
    const appended =
      !image ||
      inDraft(scopeKey, id) ||
      appendToNativeChatComposerDraft(scopeKey, { text: '', images: [image] })
    const saved = notes ? setNativeChatAttachmentNotes(scopeKey, id, notes) : true
    return appended && saved
  }
}

/** A marked copy takes this chip's place, but only while the chip is still in the draft: one sent or
 *  replaced meanwhile (in another viewer or window) vetoes the copy. */
export function replaceNativeChatNotedImage(scopeKey: string, id: string): (() => boolean) | false {
  return inDraft(scopeKey, id) ? takeNativeChatNotedImage(scopeKey, id, true) : false
}

// Marked images reopened in a viewer, per chat, with how many viewers have each open. They stay in
// the draft, so a reload keeps them, but no message box sends them until every viewer editing them
// has swapped in its edited copy or closed. Other windows see the edit through a shared marker; one
// left by a window that went away without ending its edit stops counting after a while.
const editingImages = new Map<string, Map<string, number>>()
const EDITING_KEY = 'orca.nativeChat.notesEditing.v1'
const EDITING_FRESH_MS = 10 * 60_000
const editingItem = (scopeKey: string, id: string): string =>
  `${EDITING_KEY}:${encodeURIComponent(`${scopeKey}\u0000${id}`)}`
const shareEditing = (scopeKey: string, id: string, editing: boolean): void => {
  try {
    if (editing) {
      globalThis.localStorage?.setItem(editingItem(scopeKey, id), String(Date.now()))
    } else {
      globalThis.localStorage?.removeItem(editingItem(scopeKey, id))
    }
  } catch {
    // Without shared storage the edit is still held back in this window.
  }
}
const editedElsewhere = (scopeKey: string, id: string): boolean => {
  try {
    const at = Number(globalThis.localStorage?.getItem(editingItem(scopeKey, id)) ?? 0)
    return at > Date.now() - EDITING_FRESH_MS
  } catch {
    return false
  }
}

/** Flags a reopened marked image as being edited; the returned function ends this viewer's edit. */
export function markNativeChatNotedImageEditing(scopeKey: string, id: string): () => void {
  const ids = editingImages.get(scopeKey) ?? new Map<string, number>()
  ids.set(id, (ids.get(id) ?? 0) + 1)
  editingImages.set(scopeKey, ids)
  shareEditing(scopeKey, id, true)
  let ended = false
  return () => {
    if (ended) {
      return
    }
    ended = true
    const left = (ids.get(id) ?? 1) - 1
    if (left > 0) {
      ids.set(id, left)
    } else {
      ids.delete(id)
      shareEditing(scopeKey, id, false)
    }
    if (ids.size === 0 && editingImages.get(scopeKey) === ids) {
      editingImages.delete(scopeKey)
    }
  }
}

/** Whether the draft holds a marked image whose notes are open for editing, here or in another
 *  window. */
export function nativeChatDraftHasEditingImage(scopeKey: string): boolean {
  const ids = editingImages.get(scopeKey)
  return readNativeChatComposerDraft(scopeKey).images.some(
    ({ id }) => ids?.has(id) === true || editedElsewhere(scopeKey, id)
  )
}

let cleanSequence = 0

/** A marked image whose notes were all deleted goes back to the clean original it was made from. */
export function restoreNativeChatCleanImage(
  scopeKey: string,
  id: string,
  notes: NativeChatAttachmentNotes
): () => void {
  const putBack = takeNativeChatNotedImage(scopeKey, id, true)
  const path = notes.source.path
  if (!path) {
    return putBack
  }
  cleanSequence += 1
  const cleanId = `notes-clean-${Date.now().toString(36)}-${cleanSequence}`
  const connectionId = notes.source.connectionId
  appendToNativeChatComposerDraft(scopeKey, {
    text: '',
    images: [{ id: cleanId, path, ...(connectionId ? { connectionId } : {}) }]
  })
  // Undo puts the marked image back first; the clean one goes only once that is durable.
  return () => {
    if (putBack()) {
      removeImageWithReferences(scopeKey, null, cleanId)
    }
  }
}

/** The clean original a marked image was made from, read only while its viewer is open: its source,
 *  or `failed` once it can't be read (moved, deleted, unreachable). */
export function useNativeChatNotesOriginal(
  notes: NativeChatAttachmentNotes | null,
  active: boolean,
  readContext: Parameters<typeof useLocalImageSrc>[3]
): { src: string | undefined; failed: boolean } {
  const path = active ? notes?.source.path : undefined
  const connectionId = notes?.source.connectionId
  const src = useLocalImageSrc(path, path ?? '', connectionId, readContext, chatImageAccess())
  const [failedPath, setFailedPath] = useState<string | null>(null)
  useEffect(() => {
    if (!path) {
      return
    }
    let live = true
    const fail = (): void => {
      if (live) {
        setFailedPath(path)
      }
    }
    loadLocalImageSrc(path, path, connectionId, readContext, chatImageAccess())
      .then((url) => {
        if (!url) {
          fail()
        }
      })
      .catch(fail)
    return () => {
      live = false
    }
  }, [connectionId, path, readContext])
  // Notes on media with no file path (a URL) have no original to read: the marked copy is view-only.
  const noOriginal = active && notes !== null && !notes.source.path
  return { src, failed: noOriginal || (path !== undefined && failedPath === path && !src) }
}
