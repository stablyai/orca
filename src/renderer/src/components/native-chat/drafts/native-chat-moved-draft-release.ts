import { deferredRemovals } from './native-chat-composer-draft-memory'
import { clearNativeChatAttachmentNotesWhere } from '../media/notes/native-chat-attachment-notes'
import { clearNativeChatHeldNotesWhere } from '../media/notes/native-chat-held-notes'

/** A draft moved to another scope is saved there, so its source is gone for good: so is the
 *  source's copy of the draft's notes and of the notes held for its chat. Until then a restart that
 *  recovers the source finds them with it. */
export function releaseMovedNativeChatDraftSource(sourceScope: string): void {
  deferredRemovals.delete(sourceScope)
  clearNativeChatAttachmentNotesWhere((scope) => scope === sourceScope)
  clearNativeChatHeldNotesWhere((scope) => scope === sourceScope)
}
