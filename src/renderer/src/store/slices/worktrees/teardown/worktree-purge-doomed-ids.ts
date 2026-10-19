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
    // Why: drop the auto-derived detached-HEAD display name so the module-level map doesn't retain removed worktrees for the session.
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
  // Collect every tab id (and removed file id) we are about to orphan.
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
    // Null-tolerant like the omit* helpers below: some callers pass partial state omitting this slice (production store always inits to {}).
    addDoomedTabPtyIds(tab.id, tab.ptyId)
    // Why: a removed worktree's panes are gone, so drop their hibernation output epochs from the module-level map (a future pane mints a fresh leafId at epoch 0).
    forgetAgentHibernationTabOutput(tab.id)
  }
  // Why: same rationale for doomed tabs' foreground last-seen timestamps and agent-startup delivery guards — retired tab ids never recur.
  forgetForegroundTerminalTabs(doomedTabIds)
  forgetAgentStartupDeliveriesForTabs(doomedTabIds)
  // Why: pane-authority aliases outlive the store maps they route to, so a purged
  // tab would leave a permanent entry pointing at a pane that no longer exists.
  forgetAgentPaneAuthorityAliasesByTabIds(doomedTabIds)
  // Why: per-page browser maps are keyed by page id, so collect every page of a doomed workspace to evict here (the authoritative-scan reconcile skips closeBrowserTab's cleanup).
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
