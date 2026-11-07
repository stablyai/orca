import { currentDraftScope } from './native-chat-launch-draft-source'
import {
  structuredAgentSessionIdOfDraftScope,
  nativeChatDraftScopeTabId
} from './native-chat-composer-draft-scope'
import type {
  NativeChatComposerDraftOwner,
  StoredNativeChatComposerDraft
} from './native-chat-composer-draft-storage'
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
import { releaseNativeChatStagedFiles } from './native-chat-draft-attachment-staging'

export function deleteNativeChatComposerDraftsWhere(
  matches: (scope: string, draft: StoredNativeChatComposerDraft | undefined) => boolean
): void {
  deleteLoadingNativeChatComposerDraftsWhere(matches)
  retireNativeChatComposerSubmissionsWhere(matches)
  for (const scope of new Set([...records.keys(), ...scopeListeners.keys()])) {
    const draft = records.get(scope)
    if (matches(scope, draft)) {
      releaseNativeChatStagedFiles(scope)
      installNativeChatDraftRecord(scope)
      reconcileRestoredImageChecks(scope, [])
      notifyScope(scope)
      if (draft) {
        persistNativeChatComposerDraft(scope, 'immediate')
      }
    }
  }
}

export function deleteNativeChatComposerDraft(scopeKey: string): void {
  scopeKey = currentDraftScope(scopeKey)
  deleteNativeChatComposerDraftsWhere((key) => key === scopeKey)
}

/** Delete closed-tab pane drafts; conversation-scoped drafts outlive their tabs. */
export function deleteNativeChatComposerDraftsForTab(tabId: string): void {
  deleteNativeChatComposerDraftsWhere(
    (scopeKey) =>
      structuredAgentSessionIdOfDraftScope(scopeKey) === null &&
      nativeChatDraftScopeTabId(scopeKey) === tabId
  )
}

/** Setup/pane context is local; materialized conversations require current membership. */
export function deleteNativeChatComposerDraftsOwnedBy(owner: NativeChatComposerDraftOwner): void {
  deleteNativeChatComposerDraftsWhere(
    (scopeKey, draft) =>
      structuredAgentSessionIdOfDraftScope(scopeKey) === null &&
      draft?.owner?.workspaceId === owner.workspaceId &&
      draft.owner.executionHostId === owner.executionHostId
  )
}
