import type { AppState } from '../../../types'
import type { WorkspaceLineage } from '../../../../../../shared/worktree/lineage-types'
import { isWorkspaceKey, worktreeWorkspaceKey } from '../../../../../../shared/workspace-scope'
import { normalizeRightSidebarRoute } from '../../../right-sidebar-route'
import type { WorktreePurgeDoomedIds } from './worktree-purge-doomed-ids'

export function createWorktreePurgeOmitters(
  s: AppState,
  worktreeIdSet: Set<string>,
  doomed: WorktreePurgeDoomedIds
) {
  const { doomedTabIds, doomedPtyIds, doomedBrowserWorkspaceIds, doomedPageIds, removedFileIds } =
    doomed
  const omitByWorktree = <T>(obj: Record<string, T>): Record<string, T> => {
    let changed = false
    const out = { ...obj }
    for (const id of worktreeIdSet) {
      if (id in out) {
        delete out[id]
        changed = true
      }
    }
    return changed ? out : obj
  }
  const omitWorkspaceLineageByWorktree = (
    obj: Record<string, WorkspaceLineage>
  ): Record<string, WorkspaceLineage> => {
    let changed = false
    const out = { ...obj }
    for (const id of worktreeIdSet) {
      const childKey = isWorkspaceKey(id) ? id : worktreeWorkspaceKey(id)
      if (childKey in out) {
        delete out[childKey]
        changed = true
      }
    }
    return changed ? out : obj
  }
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
  const omitByTabId = <T>(obj: Record<string, T>): Record<string, T> => {
    let changed = false
    const out = { ...obj }
    for (const tabId of doomedTabIds) {
      if (tabId in out) {
        delete out[tabId]
        changed = true
      }
    }
    return changed ? out : obj
  }
  const survivingTabIds = new Set(
    Object.entries(s.tabsByWorktree)
      .filter(([worktreeId]) => !worktreeIdSet.has(worktreeId))
      .flatMap(([, tabs]) => tabs.map((tab) => tab.id))
  )
  const omitRetiredDirectSshLedgerByTabId = <T>(obj: Record<string, T>): Record<string, T> => {
    let changed = false
    const out = { ...obj }
    for (const tabId of doomedTabIds) {
      if (!survivingTabIds.has(tabId) && tabId in out) {
        delete out[tabId]
        changed = true
      }
    }
    return changed ? out : obj
  }
  const omitByPtyId = <T>(obj: Record<string, T>): Record<string, T> => {
    let changed = false
    const out = { ...obj }
    for (const ptyId of doomedPtyIds) {
      if (ptyId in out) {
        delete out[ptyId]
        changed = true
      }
    }
    return changed ? out : obj
  }
  // Pane-scoped maps are keyed `${tabId}:${leafId}`; tabId never contains ":", so the prefix before the first ":" is the owning tab.
  const omitByPaneKeyTabPrefix = <T>(obj: Record<string, T>): Record<string, T> => {
    // Null-tolerant like omitByTabId: some worktree-isolation callers omit these slices (production store always inits to {}).
    if (!obj) {
      return obj
    }
    let changed = false
    const out = { ...obj }
    for (const paneKey of Object.keys(obj)) {
      const sep = paneKey.indexOf(':')
      if (sep > 0 && doomedTabIds.has(paneKey.slice(0, sep))) {
        delete out[paneKey]
        changed = true
      }
    }
    return changed ? out : obj
  }
  // Why a list and not a map: the two session-grid preferences are flat arrays of tab ids,
  // so `omitByTabId` cannot reach them. Identity-guarded — an unchanged array must not read
  // as a local edit to the persisted-UI writer, which is what would re-send it on every purge.
  const omitTabIdsFromList = (ids: readonly string[]): string[] => {
    // Null-tolerant like omitByPaneKeyTabPrefix: worktree-isolation callers pass a partial
    // state omitting these slices (production store always inits them to []).
    if (!ids) {
      return ids
    }
    return ids.some((id) => doomedTabIds.has(id))
      ? ids.filter((id) => !doomedTabIds.has(id))
      : (ids as string[])
  }
  const omitByBrowserWorkspaceId = <T>(obj: Record<string, T>): Record<string, T> => {
    let changed = false
    const out = { ...obj }
    for (const workspaceId of doomedBrowserWorkspaceIds) {
      if (workspaceId in out) {
        delete out[workspaceId]
        changed = true
      }
    }
    return changed ? out : obj
  }
  const omitByPageId = <T>(obj: Record<string, T>): Record<string, T> => {
    let changed = false
    const out = { ...obj }
    for (const pageId of doomedPageIds) {
      if (pageId in out) {
        delete out[pageId]
        changed = true
      }
    }
    return changed ? out : obj
  }
  const omitByFileId = <T>(obj: Record<string, T>): Record<string, T> => {
    let changed = false
    const out = { ...obj }
    for (const fileId of removedFileIds) {
      if (fileId in out) {
        delete out[fileId]
        changed = true
      }
    }
    return changed ? out : obj
  }

  return {
    omitByWorktree,
    omitWorkspaceLineageByWorktree,
    pruneRightSidebarTabByWorktree,
    omitByTabId,
    omitRetiredDirectSshLedgerByTabId,
    omitByPtyId,
    omitByPaneKeyTabPrefix,
    omitTabIdsFromList,
    omitByBrowserWorkspaceId,
    omitByPageId,
    omitByFileId
  }
}
