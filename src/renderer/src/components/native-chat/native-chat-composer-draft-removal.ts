import {
  installNativeChatDraftRecord,
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
  matches: (scope: string, draft: StoredNativeChatComposerDraft | undefined) => boolean
): void {
  deleteLoadingNativeChatComposerDraftsWhere(matches)
  retireNativeChatComposerSubmissionsWhere(matches)
  for (const scope of new Set([...records.keys(), ...scopeListeners.keys()])) {
    const draft = records.get(scope)
    if (matches(scope, draft)) {
      installNativeChatDraftRecord(scope)
      reconcileRestoredImageChecks(scope, [])
      notifyScope(scope)
      if (draft) {
        persistNativeChatComposerDraft(scope, 'immediate')
      }
    }
  }
}
