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
import {
  nativeChatStagedScopes,
  releaseNativeChatStagedFiles
} from './native-chat-draft-attachment-staging'
import { retireDeferredNativeChatComposerNoticesWhere } from '../composer/controls/native-chat-deferred-composer-notice'
import type {
  StoredNativeChatComposerDraft,
  NativeChatComposerDraftOwner
} from './native-chat-composer-draft-storage'

export function deleteNativeChatComposerDraftsWhere(
  matches: (scope: string, draft: StoredNativeChatComposerDraft | undefined) => boolean
): void {
  deleteLoadingNativeChatComposerDraftsWhere(matches)
  retireNativeChatComposerSubmissionsWhere(matches)
  // A paste failure waiting for this draft's next composer has no reader once the draft is gone. It is
  // matched by the owner confirmed for the notice, which outranks a stored record's owner: that record may
  // predate the move that brought the notice here, and only governs the stored input below.
  retireDeferredNativeChatComposerNoticesWhere((scope, owner) => {
    const record = records.get(scope)
    return matches(
      scope,
      owner ? { ...(record ?? { text: '', images: [], savedAt: 0 }), owner } : record
    )
  })
  // Files staged for a scope with no recorded draft or subscriber (a provisional destination, or a draft
  // cleared and unmounted while a send lease kept its originals) go with a matching deletion too.
  for (const scope of nativeChatStagedScopes()) {
    if (!records.has(scope) && !scopeListeners.has(scope) && matches(scope, undefined)) {
      releaseNativeChatStagedFiles(scope)
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
