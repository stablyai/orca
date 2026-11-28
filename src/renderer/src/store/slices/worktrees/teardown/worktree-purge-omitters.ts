import { annotateBrowserPageHandles } from '@/store/slices/browser/hosts/browser-initialization-presentation-ownership'
import type { AppState } from '../../../types'
import type { WorkspaceLineage } from '../../../../../../shared/worktree/lineage-types'
import { chatPaneKeySessionId } from '../../../../../../shared/agent-session/view/structured-agent-session-projection'
import type { ChatReadMarkField } from '../../../../../../shared/agent-session/view/chat-read-mark-move'
import {
  isWorkspaceKey,
  worktreeWorkspaceKey
} from '../../../../../../shared/workspace/identity/workspace-scope'
import { normalizeRightSidebarRoute } from '../../right-sidebar/right-sidebar-route'
import {
  deleteChatReadMark,
  knownChatReadMarkKey
} from '../../agent-status/structured-sessions/chat-read-mark-aliases'
import { recordDraft } from '../../../record-transitions/keyed-record-transitions'
import type { WorktreePurgeDoomedIds } from './worktree-purge-doomed-ids'
import { omitRecordKeys } from './record-key-omission'

export function createWorktreePurgeOmitters(
  s: AppState,
  worktreeIdSet: Set<string>,
  doomed: WorktreePurgeDoomedIds
) {
  const {
    doomedTabIds,
    doomedChatPaneKeys,
    doomedPtyIds,
    doomedBrowserWorkspaceIds,
    doomedPageIds,
    removedFileIds
  } = doomed
  const omitByWorktree = <T>(obj: Record<string, T>): Record<string, T> =>
    omitRecordKeys(obj, worktreeIdSet)
  const omitWorkspaceLineageByWorktree = (
    obj: Record<string, WorkspaceLineage>
  ): Record<string, WorkspaceLineage> =>
    omitRecordKeys(
      obj,
      [...worktreeIdSet].map((id) => (isWorkspaceKey(id) ? id : worktreeWorkspaceKey(id)))
    )
  // Why both forms: session-keyed maps hold bare worktree ids and `worktree:` aliases.
  const omitWorkspaceSessionKeyByWorktree = <T>(obj: Record<string, T>): Record<string, T> =>
    omitRecordKeys(
      obj,
      [...worktreeIdSet].flatMap((id) =>
        isWorkspaceKey(id) ? [id] : [id, worktreeWorkspaceKey(id)]
      )
    )
  const pruneRightSidebarTabByWorktree = (): AppState['rightSidebarTabByWorktree'] => {
    const omitted = omitByWorktree(s.rightSidebarTabByWorktree)
    let changed = omitted !== s.rightSidebarTabByWorktree
    const out: AppState['rightSidebarTabByWorktree'] = {}
    for (const [id, tab] of Object.entries(omitted)) {
      // Reuse the route validator so newer tabs (pr-checks, plugin panels) aren't silently dropped.
      if (normalizeRightSidebarRoute(tab).rightSidebarTab === tab) {
        out[id] = tab
      } else {
        changed = true
      }
    }
    return changed ? out : omitted
  }
  const omitByTabId = <T>(obj: Record<string, T>): Record<string, T> =>
    omitRecordKeys(obj, doomedTabIds)
  const omitByPtyId = <T>(obj: Record<string, T>): Record<string, T> =>
    omitRecordKeys(obj, doomedPtyIds)
  const isDoomedPaneKey = (paneKey: string): boolean => {
    if (doomedChatPaneKeys.has(paneKey)) {
      return true
    }
    const sep = paneKey.indexOf(':')
    // A conversation address can coincide with the id of a tab showing a different chat.
    return (
      sep > 0 && doomedTabIds.has(paneKey.slice(0, sep)) && chatPaneKeySessionId(paneKey) === null
    )
  }
  const omitByPaneKey = <T>(obj: Record<string, T>): Record<string, T> => {
    // Null-tolerant like omitByTabId: some worktree-isolation callers omit these slices (production store always inits to {}).
    if (!obj) {
      return obj
    }
    return omitRecordKeys(obj, Object.keys(obj).filter(isDoomedPaneKey))
  }
  const omitReadMarksByPaneKey = (field: ChatReadMarkField): Record<string, number> => {
    const marks = s[field]
    if (!marks) {
      return marks
    }
    const draft = recordDraft(marks)
    for (const paneKey of doomedChatPaneKeys) {
      deleteChatReadMark(draft, field, paneKey)
    }
    for (const paneKey of Object.keys(marks)) {
      const chatKey = knownChatReadMarkKey(field, paneKey)
      if (chatKey !== null && isDoomedPaneKey(chatKey ?? paneKey)) {
        draft.delete(paneKey)
      }
    }
    return draft.finish()
  }
  const omitByBrowserWorkspaceId = <T>(obj: Record<string, T>): Record<string, T> =>
    omitRecordKeys(obj, doomedBrowserWorkspaceIds)
  const omitByPageId = <T>(obj: Record<string, T>): Record<string, T> =>
    omitRecordKeys(obj, doomedPageIds)
  const omitByFileId = <T>(obj: Record<string, T>): Record<string, T> =>
    omitRecordKeys(obj, removedFileIds)

  return {
    omitByWorktree,
    omitWorkspaceLineageByWorktree,
    omitWorkspaceSessionKeyByWorktree,
    pruneRightSidebarTabByWorktree,
    omitByTabId,
    omitByPtyId,
    isDoomedPaneKey,
    omitByPaneKey,
    omitReadMarksByPaneKey,
    omitByBrowserWorkspaceId,
    omitByPageId,
    omitBrowserPageHandles: () =>
      annotateBrowserPageHandles(
        omitByPageId(s.remoteBrowserPageHandlesByPageId),
        doomedPageIds,
        s.remoteBrowserPageHandlesByPageId
      ),
    omitByFileId
  }
}
