import type { AppState } from '../../../types'
import { forgetAgentHibernationTabOutput } from '@/lib/agent-hibernation-output-activity'
import { forgetForegroundTerminalTabs } from '@/lib/foreground-terminal-tabs'
import { forgetAgentStartupDeliveriesForTabs } from '@/lib/agent-startup-delivery-guards'
import { forgetAgentPaneAuthorityAliasesByTabIds } from '../../agent-pane-authority'
import { forgetDetachedHeadAutoDerivedDisplayName } from '../metadata/detached-head-display-name'

export type WorktreePurgeDoomedIds = {
  doomedTabIds: Set<string>
  doomedPtyIds: Set<string>
  doomedBrowserWorkspaceIds: Set<string>
  doomedPageIds: Set<string>
  removedFileIds: Set<string>
}

export function collectWorktreePurgeDoomedIds(
  s: AppState,
  worktreeIdSet: Set<string>
): WorktreePurgeDoomedIds {
  const tabs: { id: string; ptyId: string | null }[] = []
  const browserWorkspaceIds: string[] = []
  const fileIds: string[] = []
  for (const id of worktreeIdSet) {
    tabs.push(...(s.tabsByWorktree[id] ?? []))
    for (const workspace of s.browserTabsByWorktree[id] ?? []) {
      browserWorkspaceIds.push(workspace.id)
    }
    forgetDetachedHeadAutoDerivedDisplayName(id)
  }
  for (const file of s.openFiles) {
    if (worktreeIdSet.has(file.worktreeId)) {
      fileIds.push(file.id)
      if (file.markdownPreviewSourceFileId) {
        fileIds.push(file.markdownPreviewSourceFileId)
      }
    }
  }
  return collectSurfacePurgeDoomedIds(s, { tabs, browserWorkspaceIds, fileIds })
}

/** Doomed ids for named surfaces, which may sit in a workspace that stays (a surviving twin's). */
export function collectSurfacePurgeDoomedIds(
  s: AppState,
  surfaces: {
    tabs: readonly { id: string; ptyId: string | null }[]
    browserWorkspaceIds: Iterable<string>
    fileIds: Iterable<string>
  }
): WorktreePurgeDoomedIds {
  const doomedTabIds = new Set<string>()
  // Why: some terminal/agent maps are keyed by ptyId, not tabId; collect durable wake hints too since slept panes have left the live index.
  const doomedPtyIds = new Set<string>()
  const addDoomedPtyId = (ptyId: string | null | undefined): void => {
    if (!ptyId) {
      return
    }
    doomedPtyIds.add(ptyId)
  }
  const addDoomedTabPtyIds = (tabId: string, tabPtyId: string | null | undefined): void => {
    for (const ptyId of s.ptyIdsByTabId?.[tabId] ?? []) {
      addDoomedPtyId(ptyId)
    }
    addDoomedPtyId(tabPtyId)
    addDoomedPtyId(s.lastKnownRelayPtyIdByTabId?.[tabId])
    for (const ptyId of Object.values(s.terminalLayoutsByTabId?.[tabId]?.ptyIdsByLeafId ?? {})) {
      addDoomedPtyId(ptyId)
    }
  }
  const doomedBrowserWorkspaceIds = new Set(surfaces.browserWorkspaceIds)
  const doomedPageIds = new Set<string>()
  const removedFileIds = new Set(surfaces.fileIds)
  for (const tab of surfaces.tabs) {
    doomedTabIds.add(tab.id)
    addDoomedTabPtyIds(tab.id, tab.ptyId)
    forgetAgentHibernationTabOutput(tab.id)
  }
  forgetForegroundTerminalTabs(doomedTabIds)
  forgetAgentStartupDeliveriesForTabs(doomedTabIds)
  // Authority aliases outlive store maps; purged tabs must not leave permanent routes to missing panes.
  forgetAgentPaneAuthorityAliasesByTabIds(doomedTabIds)
  // Bulk reconcile skips closeBrowserTab, so collect all doomed workspace page IDs for eviction.
  for (const workspaceId of doomedBrowserWorkspaceIds) {
    for (const page of s.browserPagesByWorkspace[workspaceId] ?? []) {
      doomedPageIds.add(page.id)
    }
  }
  return {
    doomedTabIds,
    doomedPtyIds,
    doomedBrowserWorkspaceIds,
    doomedPageIds,
    removedFileIds
  }
}
