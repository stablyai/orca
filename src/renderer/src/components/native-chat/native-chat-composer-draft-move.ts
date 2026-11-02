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
  if (source.text !== '' || source.images.length > 0) {
    const durable = appendToNativeChatComposerDraft(destinationScope, source, owner, position)
    const destination = records.get(destinationScope)
    if (!durable && destination) {
      deferredRemovals.set(sourceScope, { destinationScope, savedAt: destination.savedAt })
    }
  }
  deleteNativeChatComposerDraft(sourceScope)
}
