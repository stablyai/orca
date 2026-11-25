import { useEffect, useState } from 'react'
import {
  loadLocalImageSrc,
  useLocalImageSrc
} from '@/components/editor/document-images/useLocalImageSrc'
import { chatImageAccess } from '@/lib/files/access/local-file-access'
import { removeImageWithReferences } from '../../composer/editor/native-chat-composer-image-references'
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

/** Takes an image out of the draft and its notes with it, returning what puts both back as they were. */
export function takeNativeChatNotedImage(scopeKey: string, id: string): () => void {
  const image = readNativeChatComposerDraft(scopeKey).images.find((entry) => entry.id === id)
  const notes = readNativeChatAttachmentNotes(scopeKey, id)
  removeImageWithReferences(scopeKey, null, id)
  clearNativeChatAttachmentNotes(scopeKey, [id])
  return () => {
    if (image && !readNativeChatComposerDraft(scopeKey).images.some((entry) => entry.id === id)) {
      appendToNativeChatComposerDraft(scopeKey, { text: '', images: [image] })
    }
    if (notes) {
      setNativeChatAttachmentNotes(scopeKey, id, notes)
    }
  }
}

/** A marked copy takes this chip's place, but only while the chip is still in the draft: one sent or
 *  replaced meanwhile (in another viewer or window) vetoes the copy. */
export function replaceNativeChatNotedImage(scopeKey: string, id: string): (() => void) | false {
  return readNativeChatComposerDraft(scopeKey).images.some((entry) => entry.id === id)
    ? takeNativeChatNotedImage(scopeKey, id)
    : false
}

// Marked images reopened in a viewer, per chat. They stay in the draft, so a reload keeps them, but
// the message box doesn't send them until the viewer swaps in the edited copy or closes.
const editingImages = new Map<string, Set<string>>()

/** Flags a reopened marked image as being edited; the returned function ends that. */
export function markNativeChatNotedImageEditing(scopeKey: string, id: string): () => void {
  const ids = editingImages.get(scopeKey) ?? new Set<string>()
  ids.add(id)
  editingImages.set(scopeKey, ids)
  return () => {
    ids.delete(id)
    if (ids.size === 0 && editingImages.get(scopeKey) === ids) {
      editingImages.delete(scopeKey)
    }
  }
}

/** Whether the draft holds a marked image whose notes are open for editing. */
export function nativeChatDraftHasEditingImage(scopeKey: string): boolean {
  const ids = editingImages.get(scopeKey)
  return (
    Boolean(ids?.size) &&
    readNativeChatComposerDraft(scopeKey).images.some(({ id }) => ids!.has(id))
  )
}

let cleanSequence = 0

/** A marked image whose notes were all deleted goes back to the clean original it was made from. */
export function restoreNativeChatCleanImage(
  scopeKey: string,
  id: string,
  notes: NativeChatAttachmentNotes
): () => void {
  const putBack = takeNativeChatNotedImage(scopeKey, id)
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
  return () => {
    removeImageWithReferences(scopeKey, null, cleanId)
    putBack()
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
