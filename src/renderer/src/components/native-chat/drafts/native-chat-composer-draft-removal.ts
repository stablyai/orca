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
import {
  deferredNativeChatComposerNoticeScopes,
  retireDeferredNativeChatComposerNotices
} from '../composer/controls/native-chat-deferred-composer-notice'
import type {
  StoredNativeChatComposerDraft,
  NativeChatComposerDraftOwner
} from './native-chat-composer-draft-storage'

export function deleteNativeChatComposerDraftsWhere(
  matches: (scope: string, draft: StoredNativeChatComposerDraft | undefined) => boolean
): void {
  deleteLoadingNativeChatComposerDraftsWhere(matches)
  retireNativeChatComposerSubmissionsWhere(matches)
  // A paste failure waiting for this draft's next composer has no reader once the draft is gone.
  for (const scope of deferredNativeChatComposerNoticeScopes()) {
    if (matches(scope, records.get(scope))) {
      retireDeferredNativeChatComposerNotices(scope)
    }
  }
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

import { currentDraftScope } from './native-chat-launch-draft-source'
import {
  STRUCTURED_AGENT_SESSION_DRAFT_SCOPE_PREFIX,
  nativeChatDraftScopeTabId
} from './native-chat-draft-scope'

export function deleteNativeChatComposerDraft(scopeKey: string): void {
  scopeKey = currentDraftScope(scopeKey)
  deleteNativeChatComposerDraftsWhere((key) => key === scopeKey)
}

/** Delete closed-tab pane drafts; conversation-scoped drafts outlive their tabs. */
export function deleteNativeChatComposerDraftsForTab(tabId: string): void {
  deleteNativeChatComposerDraftsWhere(
    (scopeKey) =>
      !scopeKey.startsWith(STRUCTURED_AGENT_SESSION_DRAFT_SCOPE_PREFIX) &&
      nativeChatDraftScopeTabId(scopeKey) === tabId
  )
}

/** Drops every draft written in a workspace the user removed, open and closed chats alike. */
export function deleteNativeChatComposerDraftsOwnedBy(owner: NativeChatComposerDraftOwner): void {
  deleteNativeChatComposerDraftsWhere(
    (_scopeKey, draft) =>
      draft?.owner?.workspaceId === owner.workspaceId &&
      draft.owner.executionHostId === owner.executionHostId
  )
}
