import { useEffect, useState } from 'react'
import {
  loadLocalImageSrc,
  useLocalImageSrc
} from '@/components/editor/document-images/useLocalImageSrc'
import { chatImageAccess } from '@/lib/files/access/local-file-access'
import { removeImageWithReferences } from '../../composer/editor/native-chat-composer-image-references'
import { whenNativeChatComposerDraftSaved } from '../../drafts/native-chat-composer-draft-saved'
import { nominateNativeChatMediaViewerReplacement } from './use-native-chat-media-viewer-focus'
// Chips show notes a move left under its source; this adopts them where their draft is now.
import '../../drafts/native-chat-moved-draft-adoption'
import {
  claimNativeChatNotesEdit,
  nativeChatNotesEditClaimed,
  nativeChatNotesEditClaimedElsewhere
} from './native-chat-notes-edit-claims'
import {
  appendToNativeChatComposerDraft,
  readNativeChatComposerDraft,
  updateNativeChatComposerDraft
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
): (ignoring?: readonly string[]) => boolean {
  const draft = readNativeChatComposerDraft(scopeKey)
  const at = draft.images.findIndex((entry) => entry.id === id)
  const image = draft.images[at]
  // The image after it: Undo puts this one back in front of it, so the numbering is as it was.
  const next = draft.images[at + 1]?.id
  const notes = readNativeChatAttachmentNotes(scopeKey, id)
  removeImageWithReferences(scopeKey, null, id)
  const left = readNativeChatComposerDraft(scopeKey)
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
  // `ignoring`: images the same step added in its place (Clear's clean original), not a change.
  return (ignoring: readonly string[] = []) => {
    const now = readNativeChatComposerDraft(scopeKey)
    const ids = (images: readonly { id: string }[]): string =>
      images
        .map((entry) => entry.id)
        .filter((entry) => !ignoring.includes(entry))
        .join('\u0000')
    // Untouched since: its words come back exactly as they were, the image's references included.
    const untouched = now.text === left.text && ids(now.images) === ids(left.images)
    // Back in the draft durably (saved or journaled), in its place, and its notes saved, or this
    // reports false.
    const appended =
      !image ||
      inDraft(scopeKey, id) ||
      appendToNativeChatComposerDraft(scopeKey, {
        text: '',
        images: [image],
        ...(next && inDraft(scopeKey, next) ? { before: next } : {})
      })
    if (image && untouched && appended) {
      updateNativeChatComposerDraft(
        scopeKey,
        { text: draft.text, document: draft.document },
        'immediate'
      )
    }
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
// the draft, so a reload keeps them, but no message box sends them until every viewer editing them,
// in any window, has swapped in its edited copy or closed (see the edit claims).
const editingImages = new Map<string, Map<string, number>>()

/** Flags a reopened marked image as being edited; the returned function ends this viewer's edit. */
export function markNativeChatNotedImageEditing(scopeKey: string, id: string): () => void {
  const ids = editingImages.get(scopeKey) ?? new Map<string, number>()
  ids.set(id, (ids.get(id) ?? 0) + 1)
  editingImages.set(scopeKey, ids)
  const endClaim = claimNativeChatNotesEdit(scopeKey, id)
  let ended = false
  return () => {
    if (ended) {
      return
    }
    ended = true
    endClaim()
    const left = (ids.get(id) ?? 1) - 1
    if (left > 0) {
      ids.set(id, left)
    } else {
      ids.delete(id)
    }
    if (ids.size === 0 && editingImages.get(scopeKey) === ids) {
      editingImages.delete(scopeKey)
    }
  }
}

/** Whether any viewer, here or in another window, has this marked image open for editing. */
export function nativeChatNotedImageBeingEdited(scopeKey: string, id: string): boolean {
  return (
    (editingImages.get(scopeKey)?.get(id) ?? 0) > 0 ||
    nativeChatNotesEditClaimedElsewhere(scopeKey, id)
  )
}

/** Whether another viewer, here or in another window, also has this marked image open: replacing it
 *  from one viewer would take it from under the other. */
export function nativeChatNotedImageEditedByOthers(scopeKey: string, id: string): boolean {
  return (
    (editingImages.get(scopeKey)?.get(id) ?? 0) > 1 ||
    nativeChatNotesEditClaimedElsewhere(scopeKey, id)
  )
}

/** Whether the draft holds a marked image whose notes are open for editing, here or in another
 *  window. */
export function nativeChatDraftHasEditingImage(scopeKey: string): boolean {
  const ids = editingImages.get(scopeKey)
  return readNativeChatComposerDraft(scopeKey).images.some(
    ({ id }) => ids?.has(id) === true || nativeChatNotesEditClaimed(scopeKey, id)
  )
}

let cleanSequence = 0

/** A marked image whose notes were all deleted goes back to the clean original it was made from. */
export function restoreNativeChatCleanImage(
  scopeKey: string,
  id: string,
  notes: NativeChatAttachmentNotes
): () => boolean {
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
  // Closing returns focus to the clean image that took the chip's place, not a neighbor.
  nominateNativeChatMediaViewerReplacement(cleanId)
  // Undo puts the marked image back first; the clean one goes only once that is durable.
  return () => {
    if (!putBack([cleanId])) {
      return false
    }
    removeImageWithReferences(scopeKey, null, cleanId)
    return true
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
