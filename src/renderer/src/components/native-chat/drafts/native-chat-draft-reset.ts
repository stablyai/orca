import { ephemeralDrafts, clearDraftMemoryForTests } from './native-chat-composer-draft-memory'
import { resetNativeChatComposerDraftPersistenceForTests } from './native-chat-composer-draft-persistence'
import { resetNativeChatComposerDraftLoadForTests } from './native-chat-composer-draft-load'
import { setNativeChatComposerDraftStorageForTests } from './native-chat-composer-draft-storage'
import { resetMovedNativeChatDraftSourcesForTests } from './native-chat-moved-draft-release'

export function clearNativeChatComposerDraftsForTests(): void {
  ephemeralDrafts.clear()
  clearDraftMemoryForTests()
  resetNativeChatComposerDraftPersistenceForTests()
  resetNativeChatComposerDraftLoadForTests()
  setNativeChatComposerDraftStorageForTests(null)
  resetMovedNativeChatDraftSourcesForTests()
}
