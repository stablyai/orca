import { isNativeChatEditDraft, load, records } from './native-chat-composer-draft-memory'
import { deleteNativeChatComposerDraft } from './native-chat-composer-draft-removal'
import { keepsMovedNativeChatDraftNotes } from './native-chat-moved-draft-release'
import {
  clearNativeChatAttachmentNotes,
  hasOwnNativeChatAttachmentNotes,
  setNativeChatAttachmentNotesAdoption
} from '../media/notes/native-chat-attachment-notes'
import { moveNativeChatHeldNotes } from '../media/notes/native-chat-held-notes'

// Notes left under a moved draft's source (their copy to the destination was refused, and a restart
// ended the move's own retries) are adopted by the destination once storage takes them. Then the
// source lets go: of that entry alone while its draft no longer holds the image, or of its whole
// draft once that draft is plainly the moved one (see `retireMovedSource`).

/** Retires `from` when it is plainly an older copy of `to`: written before `to` was, its words are
 *  in `to` (or it has none), every image of it is in `to` with its notes saved there, and the notes
 *  held for its chat are saved in `to` too (copied now, joining any `to` holds; refused, the source
 *  stays). A source with words `to` doesn't have, or written since, is never retired: keeping it
 *  only leaves a copy behind, retiring it could lose words. Never a queued edit, which copies a
 *  message's images without moving its draft, and never a source a move in this window still owns. */
function retireMovedSource(from: string, to: string): boolean {
  const source = records.get(from)
  const destination = records.get(to)
  if (
    !source ||
    !destination ||
    source.images.length === 0 ||
    source.savedAt >= destination.savedAt ||
    (source.text.trim() !== '' && !destination.text.includes(source.text)) ||
    isNativeChatEditDraft(from) ||
    isNativeChatEditDraft(to) ||
    keepsMovedNativeChatDraftNotes(from) ||
    !source.images.every(
      ({ id }) =>
        destination.images.some((image) => image.id === id) &&
        hasOwnNativeChatAttachmentNotes(to, id) !== false
    ) ||
    !moveNativeChatHeldNotes(from, to, true)
  ) {
    return false
  }
  deleteNativeChatComposerDraft(from)
  return true
}

setNativeChatAttachmentNotesAdoption((from, to, attachmentId) => {
  if (keepsMovedNativeChatDraftNotes(from)) {
    return
  }
  if (!records.get(from)?.images.some(({ id }) => id === attachmentId)) {
    clearNativeChatAttachmentNotes(from, [attachmentId], false)
    return
  }
  retireMovedSource(from, to)
})

let swept = false

/** Once per run, after saved drafts load: a draft that is plainly an older copy of a newer one (a
 *  move that a restart cut short after the destination was saved) retires. */
export function sweepLeftoverMovedNativeChatDrafts(): void {
  if (swept || !load.hydrated) {
    return
  }
  swept = true
  const pairs: [string, string][] = []
  for (const [scope, draft] of records) {
    const newer = [...records].find(
      ([other, target]) =>
        other !== scope &&
        target.savedAt > draft.savedAt &&
        draft.images.length > 0 &&
        draft.images.every(({ id }) => target.images.some((image) => image.id === id))
    )
    if (newer) {
      pairs.push([scope, newer[0]])
    }
  }
  for (const [from, to] of pairs) {
    retireMovedSource(from, to)
  }
}
