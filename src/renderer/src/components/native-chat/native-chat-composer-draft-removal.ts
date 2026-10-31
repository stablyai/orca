import {
  installNativeChatDraftRecord,
  nativeChatLaunchPromptDraftOwner,
  notifyScope,
  records,
  reconcileRestoredImageChecks,
  retireNativeChatComposerSubmissionsWhere,
  scopeListeners
} from './native-chat-composer-draft-memory'
import {
  deleteLoadingNativeChatComposerDraftsWhere,
  persistNativeChatComposerDraft
} from './native-chat-composer-draft-persistence'
import type { StoredNativeChatComposerDraft } from './native-chat-composer-draft-storage'

export function deleteNativeChatComposerDraftsWhere(
  matches: (scopeKey: string, draft: StoredNativeChatComposerDraft | undefined) => boolean,
  retireLaunchListeners = false
): void {
  deleteLoadingNativeChatComposerDraftsWhere(matches)
  retireNativeChatComposerSubmissionsWhere(matches)
  for (const scopeKey of new Set([...records.keys(), ...scopeListeners.keys()])) {
    const draft = records.get(scopeKey)
    if (matches(scopeKey, draft)) {
      installNativeChatDraftRecord(scopeKey)
      reconcileRestoredImageChecks(scopeKey, [])
      notifyScope(scopeKey)
      if (retireLaunchListeners && nativeChatLaunchPromptDraftOwner(scopeKey)) {
        scopeListeners.delete(scopeKey)
      }
      if (draft) {
        persistNativeChatComposerDraft(scopeKey, 'immediate')
      }
    }
  }
}
