import { ephemeralDrafts, clearDraftMemoryForTests } from './native-chat-composer-draft-memory'
import { resetNativeChatComposerDraftPersistenceForTests } from './native-chat-composer-draft-persistence'
import { resetNativeChatComposerDraftLoadForTests } from './native-chat-composer-draft-load'
import { setNativeChatComposerDraftStorageForTests } from './native-chat-composer-draft-storage'
import { clearNativeChatPendingAttachmentsForTests } from '../attachments/chips/native-chat-pending-attachment-cache'

export function clearNativeChatComposerDraftsForTests(): void {
  ephemeralDrafts.clear()
  clearDraftMemoryForTests()
  resetNativeChatComposerDraftPersistenceForTests()
  resetNativeChatComposerDraftLoadForTests()
  setNativeChatComposerDraftStorageForTests(null)
}

export function clearNativeChatAttachmentCacheForTests(): void {
  clearNativeChatComposerDraftsForTests()
  clearNativeChatPendingAttachmentsForTests()
}
