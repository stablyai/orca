import {
  appendToNativeChatComposerDraft,
  readNativeChatComposerDraft
} from './native-chat-composer-draft-store'
import { deleteNativeChatComposerDraft } from './native-chat-composer-draft-removal'
import {
  deferredRemovals,
  records,
  type NativeChatDraftPosition
} from './native-chat-composer-draft-memory'
import type {
  NativeChatComposerDraft,
  NativeChatComposerDraftOwner
} from './native-chat-composer-draft-storage'
import { moveNativeChatPendingAttachments } from '../attachments/chips/native-chat-pending-attachment-cache'
import { nativeChatPastedTextOperations } from '../paste/native-chat-pasted-text-reference'
import {
  moveNativeChatStagedFiles,
  reconcileNativeChatStagedDraft
} from './native-chat-draft-attachment-staging'
import {
  clearNativeChatAttachmentNotesWhere,
  moveNativeChatAttachmentNotes,
  saveNativeChatAttachmentNotes
} from '../media/notes/native-chat-attachment-notes'
import {
  clearNativeChatHeldNotesWhere,
  moveNativeChatHeldNotes,
  saveNativeChatHeldNotes
} from '../media/notes/native-chat-held-notes'
import {
  redirectMovedNativeChatDraftSources,
  retireMovedNativeChatDraftSource,
  setMovedNativeChatDraftSourceRelease
} from './native-chat-moved-draft-release'

// A moved draft's source keeps its copy of the notes until its removal is confirmed; then they go.
setMovedNativeChatDraftSourceRelease({
  release: (sourceScope) => {
    clearNativeChatAttachmentNotesWhere((scope) => scope === sourceScope)
    clearNativeChatHeldNotesWhere((scope) => scope === sourceScope)
  },
  // Both run: each retries its own refused writes.
  save: () => [saveNativeChatAttachmentNotes(), saveNativeChatHeldNotes()].every(Boolean)
})

/** Transfer the live draft synchronously; storage acknowledgement only governs source cleanup. */
export function moveNativeChatComposerDraft(
  sourceScope: string,
  destinationScope: string,
  owner?: NativeChatComposerDraftOwner,
  position?: (draft: NativeChatComposerDraft) => NativeChatDraftPosition
): void {
  if (sourceScope === destinationScope) {
    return
  }
  const source = readNativeChatComposerDraft(sourceScope)
  moveNativeChatStagedFiles(sourceScope, destinationScope)
  moveNativeChatPendingAttachments(sourceScope, destinationScope)
  // Notes on the draft's marked images, and notes held for its chat, go where the draft goes. The
  // source keeps its copy until its draft's removal is final, so whichever draft a restart
  // recovers still has its notes.
  const notesSaved = [
    moveNativeChatAttachmentNotes(sourceScope, destinationScope, true),
    moveNativeChatHeldNotes(sourceScope, destinationScope, true)
  ].every(Boolean)
  for (const operation of nativeChatPastedTextOperations.values()) {
    if (operation.scopeKey === sourceScope) {
      operation.scopeKey = destinationScope
    }
  }
  if (source.text !== '' || source.images.length > 0) {
    const durable = appendToNativeChatComposerDraft(destinationScope, source, owner, position)
    const destination = records.get(destinationScope)
    const savedAt = !durable && destination ? destination.savedAt : 0
    // An earlier move into this source, still unsettled, now waits for this destination instead.
    redirectMovedNativeChatDraftSources(sourceScope, destinationScope, savedAt)
    // The source stays saved until the destination's write holding the draft is confirmed and the
    // notes copied there are saved; already durable, only the notes can hold it back.
    if ((!durable && destination) || !notesSaved) {
      deferredRemovals.set(sourceScope, {
        destinationScope,
        savedAt,
        notesPending: !notesSaved
      })
    } else {
      retireMovedNativeChatDraftSource(sourceScope)
    }
  } else if (!notesSaved) {
    // Only notes moved (held for the chat): the source keeps its copies until they are saved.
    deferredRemovals.set(sourceScope, { destinationScope, savedAt: 0, notesPending: true })
  }
  reconcileNativeChatStagedDraft(destinationScope, records.get(destinationScope))
  deleteNativeChatComposerDraft(sourceScope)
}
