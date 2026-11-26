import { load, records } from './native-chat-composer-draft-memory'
import { deleteNativeChatComposerDraft } from './native-chat-composer-draft-removal'
import { keepsMovedNativeChatDraftNotes } from './native-chat-moved-draft-release'
import {
  clearNativeChatAttachmentNotes,
  hasOwnNativeChatAttachmentNotes,
  setNativeChatAttachmentNotesAdoption
} from '../media/notes/native-chat-attachment-notes'

// Notes left under a moved draft's source (their copy to the destination was refused, and a restart
// ended the move's own retries) are adopted by the destination once storage takes them. Then the
// source lets go: of that entry alone while its draft no longer holds the image, or of its whole
// draft once that draft is plainly the moved one: every image and its words are at the destination,
// and every image's notes are saved there.
setNativeChatAttachmentNotesAdoption((from, to, attachmentId) => {
  // A move still under way in this window retires its source itself.
  if (keepsMovedNativeChatDraftNotes(from)) {
    return
  }
  const source = records.get(from)
  if (!source?.images.some(({ id }) => id === attachmentId)) {
    clearNativeChatAttachmentNotes(from, [attachmentId], false)
    return
  }
  const destination = records.get(to)
  const moved =
    destination !== undefined &&
    destination.text.includes(source.text) &&
    source.images.every(
      ({ id }) =>
        destination.images.some((image) => image.id === id) &&
        hasOwnNativeChatAttachmentNotes(to, id) !== false
    )
  if (moved) {
    deleteNativeChatComposerDraft(from)
  }
})

let swept = false

/** Once per run, after saved drafts load: a draft that is plainly an older copy of another (a move
 *  that a restart cut short after the destination was saved) retires. Every image of it is in the
 *  newer draft with its notes saved there, and its words are too. */
export function sweepLeftoverMovedNativeChatDrafts(): void {
  if (swept || !load.hydrated) {
    return
  }
  swept = true
  const leftovers: string[] = []
  for (const [scope, draft] of records) {
    if (draft.images.length === 0 || keepsMovedNativeChatDraftNotes(scope)) {
      continue
    }
    const copied = [...records].some(
      ([other, target]) =>
        other !== scope &&
        target.savedAt > draft.savedAt &&
        target.text.includes(draft.text) &&
        draft.images.every(
          ({ id }) =>
            target.images.some((image) => image.id === id) &&
            hasOwnNativeChatAttachmentNotes(other, id) !== false
        )
    )
    if (copied) {
      leftovers.push(scope)
    }
  }
  for (const scope of leftovers) {
    deleteNativeChatComposerDraft(scope)
  }
}
