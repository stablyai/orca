import {
  appendToNativeChatComposerDraft,
  deleteNativeChatComposerDraft,
  readNativeChatComposerDraft
} from './native-chat-composer-draft-store'
import {
  deferredRemovals,
  records,
  type NativeChatDraftPosition
} from './native-chat-composer-draft-memory'
import type {
  NativeChatComposerDraft,
  NativeChatComposerDraftOwner
} from './native-chat-composer-draft-storage'
import { moveNativeChatPendingAttachments } from './native-chat-pending-attachment-cache'
import { nativeChatPastedTextOperations } from './native-chat-pasted-text-reference'
import {
  moveNativeChatStagedFiles,
  reconcileNativeChatStagedDraft
} from './native-chat-draft-attachment-staging'

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
  for (const operation of nativeChatPastedTextOperations.values()) {
    if (operation.scopeKey === sourceScope) {
      operation.scopeKey = destinationScope
    }
  }
  if (source.text !== '' || source.images.length > 0) {
    const durable = appendToNativeChatComposerDraft(destinationScope, source, owner, position)
    const destination = records.get(destinationScope)
    if (!durable && destination) {
      deferredRemovals.set(sourceScope, { destinationScope, savedAt: destination.savedAt })
    }
  }
  reconcileNativeChatStagedDraft(destinationScope, records.get(destinationScope))
  deleteNativeChatComposerDraft(sourceScope)
}
