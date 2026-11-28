import { discardKagiPrivateInitialNavigation } from '@/lib/kagi-private-initial-navigation'
import type { AppState } from '../../../types'
import { chatPaneKey } from '../../../../../../shared/agent-session/view/structured-agent-session-projection'
import { chatTabsShowingConversation } from '@/components/native-chat/session/status/structured-agent-session-tabs'
import { forgetAgentHibernationTabOutput } from '@/lib/agent-session/hibernation/agent-hibernation-output-activity'
import { forgetForegroundTerminalTabs } from '@/components/terminal-pane/parking/retention/foreground-terminal-tabs'
import { forgetAgentStartupDeliveriesForTabs } from '@/lib/agent-session/launch/startup/agent-startup-delivery-guards'
import { forgetAgentPaneAuthorityAliasesByTabIds } from '../../agent-status/pane-authority/agent-pane-authority'
import { forgetDetachedHeadAutoDerivedDisplayName } from '../metadata/detached-head-display-name'

export type WorktreePurgeDoomedIds = {
  doomedTabIds: Set<string>
  doomedChatPaneKeys: ReadonlySet<string>
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
  const chatPaneKeys = new Set<string>()
  const browserWorkspaceIds: string[] = []
  const fileIds: string[] = []
  for (const id of worktreeIdSet) {
    tabs.push(...(s.tabsByWorktree[id] ?? []))
    // Chat tabs live only in unifiedTabs, and a conversation can outlive its tab.
    for (const tab of s.unifiedTabsByWorktree?.[id] ?? []) {
      tabs.push({ id: tab.id, ptyId: null })
      if (tab.contentType === 'agent-session') {
        chatPaneKeys.add(chatPaneKey(tab.entityId))
      }
    }
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
  for (const paneKey of chatPaneKeys) {
    for (const tab of chatTabsShowingConversation(s.unifiedTabsByWorktree, paneKey)) {
      if (!worktreeIdSet.has(tab.worktreeId)) {
        chatPaneKeys.delete(paneKey)
        break
      }
    }
  }
  return collectSurfacePurgeDoomedIds(s, { tabs, chatPaneKeys, browserWorkspaceIds, fileIds })
}

/** Doomed ids for named surfaces, which may sit in a workspace that stays (a surviving twin's). */
export function collectSurfacePurgeDoomedIds(
  s: AppState,
  surfaces: {
    tabs: readonly { id: string; ptyId: string | null }[]
    chatPaneKeys?: ReadonlySet<string>
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
      discardKagiPrivateInitialNavigation(page.id)
    }
  }
  return {
    doomedTabIds,
    doomedChatPaneKeys: surfaces.chatPaneKeys ?? new Set(),
    doomedPtyIds,
    doomedBrowserWorkspaceIds,
    doomedPageIds,
    removedFileIds
  }
}
