import { isNativeChatEditDraft, load, records } from './native-chat-composer-draft-memory'
import { deleteNativeChatComposerDraft } from './native-chat-composer-draft-removal'
import { keepsMovedNativeChatDraftNotes } from './native-chat-moved-draft-release'
import {
  movedNativeChatDraftDestination,
  movedNativeChatDraftSources,
  pruneMovedNativeChatDraftSources
} from './native-chat-moved-draft-direction'
import {
  clearNativeChatAttachmentNotes,
  nativeChatAttachmentNotesSavedAt,
  setNativeChatAttachmentNotesAdoption
} from '../media/notes/native-chat-attachment-notes'
import {
  handOverNativeChatHeldNotes,
  moveNativeChatHeldNotes,
  nativeChatHoldsNotes
} from '../media/notes/native-chat-held-notes'

// Notes left under a moved draft's source (their copy to the destination was refused, and a restart
// ended the move's own retries) are adopted by the destination once storage takes them. Then the
// source lets go: of that entry alone while its draft no longer holds the image, or of its whole
// draft once that draft is plainly the moved one (see `retireMovedSource`).

/** Retires `from` when it is plainly an older copy of `to`: a move from `from` into `to` left it
 *  behind (so `to`, the draft its chat shows, is never the one retired), written before `to` was, its words are
 *  in `to` (or it has none), every image of it is in `to` with the same words saved there, and the notes
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
    movedNativeChatDraftDestination(from) !== to ||
    source.images.length === 0 ||
    source.savedAt >= destination.savedAt ||
    (source.text.trim() !== '' && !destination.text.includes(source.text)) ||
    isNativeChatEditDraft(from) ||
    isNativeChatEditDraft(to) ||
    keepsMovedNativeChatDraftNotes(from) ||
    !source.images.every(
      ({ id }) =>
        destination.images.some((image) => image.id === id) &&
        nativeChatAttachmentNotesSavedAt(from, to, id)
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

/** Once per run, after saved drafts load: a draft a move left behind (a restart cut the move short
 *  after its destination was saved) retires if it is plainly an older copy of where it went. */
export function sweepLeftoverMovedNativeChatDrafts(): void {
  if (swept || !load.hydrated) {
    return
  }
  swept = true
  // A move that left only notes held for its chat (no draft of its own, or a queued edit's, which
  // no later run reads): they go where the move went, the source's copies kept until that's saved.
  for (const [from, to] of movedNativeChatDraftSources()) {
    if ((!records.has(from) || isNativeChatEditDraft(from)) && nativeChatHoldsNotes(from)) {
      handOverNativeChatHeldNotes(from, to)
    }
  }
  pruneMovedNativeChatDraftSources((scope) => records.has(scope) || nativeChatHoldsNotes(scope))
  // A copy: retiring a draft deletes it from `records` mid-loop.
  for (const from of Array.from(records.keys())) {
    const to = movedNativeChatDraftDestination(from)
    if (to !== null) {
      retireMovedSource(from, to)
    }
  }
}

/** Test-only: the next load sweeps again. */
export function resetMovedNativeChatDraftSweepForTests(): void {
  swept = false
}
