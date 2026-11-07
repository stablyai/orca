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
  removeNativeChatComposerDraftRecord
} from './native-chat-composer-draft-persistence'
import { releaseNativeChatStagedFiles } from './native-chat-draft-attachment-staging'
import type { StoredNativeChatComposerDraft } from './native-chat-composer-draft-storage'
import { draftCustody, withNativeChatDraftCustody } from './native-chat-composer-draft-custody'
import { scopeInputs } from './native-chat-composer-draft-input'

export function deleteNativeChatComposerDraftsWhere(
  matches: (scope: string, draft: StoredNativeChatComposerDraft | undefined) => boolean
): void {
  deleteLoadingNativeChatComposerDraftsWhere(matches)
  retireNativeChatComposerSubmissionsWhere(matches)
  for (const scope of new Set([
    ...records.keys(),
    ...draftCustody.keys(),
    ...scopeListeners.keys()
  ])) {
    // A receipt-only record is the draft's for deletion: its workspace's removal ends it too.
    const draft = withNativeChatDraftCustody(records.get(scope), draftCustody.get(scope))
    if (matches(scope, draft)) {
      releaseNativeChatStagedFiles(scope)
      draftCustody.delete(scope)
      scopeInputs.delete(scope)
      installNativeChatDraftRecord(scope)
      reconcileRestoredImageChecks(scope, [])
      notifyScope(scope)
      if (draft) {
        removeNativeChatComposerDraftRecord(scope)
      }
    }
  }
}
