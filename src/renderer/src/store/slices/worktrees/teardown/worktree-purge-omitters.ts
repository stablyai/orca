import type { AppState } from '../../../types'
import type { WorkspaceLineage } from '../../../../../../shared/worktree/lineage-types'
import { isWorkspaceKey, worktreeWorkspaceKey } from '../../../../../../shared/workspace-scope'
import { normalizeRightSidebarRoute } from '../../../right-sidebar-route'
import type { WorktreePurgeDoomedIds } from './worktree-purge-doomed-ids'
import { omitRecordKeys } from './record-key-omission'

export function createWorktreePurgeOmitters(
  s: AppState,
  worktreeIdSet: Set<string>,
  doomed: WorktreePurgeDoomedIds
) {
  const { doomedTabIds, doomedPtyIds, doomedBrowserWorkspaceIds, doomedPageIds, removedFileIds } =
    doomed
  const omitByWorktree = <T>(obj: Record<string, T>): Record<string, T> =>
    omitRecordKeys(obj, worktreeIdSet)
  const omitWorkspaceLineageByWorktree = (
    obj: Record<string, WorkspaceLineage>
  ): Record<string, WorkspaceLineage> =>
    omitRecordKeys(
      obj,
      [...worktreeIdSet].map((id) => (isWorkspaceKey(id) ? id : worktreeWorkspaceKey(id)))
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
  const survivingTabIds = new Set(
    Object.entries(s.tabsByWorktree)
      .filter(([worktreeId]) => !worktreeIdSet.has(worktreeId))
      .flatMap(([, tabs]) => tabs.map((tab) => tab.id))
  )
  const omitRetiredDirectSshLedgerByTabId = <T>(obj: Record<string, T>): Record<string, T> =>
    omitRecordKeys(
      obj,
      [...doomedTabIds].filter((tabId) => !survivingTabIds.has(tabId))
    )
  const omitByPtyId = <T>(obj: Record<string, T>): Record<string, T> =>
    omitRecordKeys(obj, doomedPtyIds)
  // Pane-scoped maps are keyed `${tabId}:${leafId}`; tabId never contains ":", so the prefix before the first ":" is the owning tab.
  const omitByPaneKeyTabPrefix = <T>(obj: Record<string, T>): Record<string, T> => {
    // Null-tolerant like omitByTabId: some worktree-isolation callers omit these slices (production store always inits to {}).
    if (!obj) {
      return obj
    }
    return omitRecordKeys(
      obj,
      Object.keys(obj).filter((paneKey) => {
        const sep = paneKey.indexOf(':')
        return sep > 0 && doomedTabIds.has(paneKey.slice(0, sep))
      })
    )
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
    pruneRightSidebarTabByWorktree,
    omitByTabId,
    omitRetiredDirectSshLedgerByTabId,
    omitByPtyId,
    omitByPaneKeyTabPrefix,
    omitByBrowserWorkspaceId,
    omitByPageId,
    omitByFileId
  }
}
