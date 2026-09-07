import type { WorktreeSlice } from '../../worktree-helpers'
import type { WorktreeSliceGet, WorktreeSliceSet } from '../listing/worktree-slice-types'
import { folderWorkspaceKey } from '../../../../../../shared/workspace-scope'
import { markInputQuietSchedulerInput } from '@/lib/input-quiet-scheduler'
import { moveFocusToRendererBeforeFocusedWebviewHidden } from '../../browser-webview-cleanup'
import {
  findKnownWorktreeById,
  folderWorkspaceMatchesHost
} from '../listing/detected-worktree-meta'
import { shouldDeferActivationTerminalPrep } from './activation-terminal-prep'

export function createSetActiveFolderWorkspace(
  set: WorktreeSliceSet,
  get: WorktreeSliceGet
): WorktreeSlice['setActiveFolderWorkspace'] {
  return (folderWorkspaceId, executionHostId) => {
    const workspaceKey = folderWorkspaceKey(folderWorkspaceId)
    const workspace = findKnownWorktreeById(get(), workspaceKey, executionHostId)
    if (!workspace) {
      return
    }
    if (shouldDeferActivationTerminalPrep()) {
      markInputQuietSchedulerInput()
    }
    if (get().activeWorktreeId !== workspaceKey) {
      moveFocusToRendererBeforeFocusedWebviewHidden()
    }
    const reconciledActiveTabId =
      get().reconcileWorktreeTabModel(workspaceKey).activeRenderableTabId
    set((s) => {
      const restoredFileId = s.activeFileIdByWorktree[workspaceKey] ?? null
      const restoredBrowserTabId = s.activeBrowserTabIdByWorktree[workspaceKey] ?? null
      const restoredTabType = s.activeTabTypeByWorktree[workspaceKey] ?? 'terminal'
      const activeGroupId =
        s.activeGroupIdByWorktree[workspaceKey] ?? s.groupsByWorktree[workspaceKey]?.[0]?.id ?? null
      const activeGroup = activeGroupId
        ? ((s.groupsByWorktree[workspaceKey] ?? []).find((group) => group.id === activeGroupId) ??
          null)
        : null
      const activeUnifiedTabId = reconciledActiveTabId ?? activeGroup?.activeTabId ?? null
      const activeUnifiedTab =
        activeUnifiedTabId != null
          ? ((s.unifiedTabsByWorktree[workspaceKey] ?? []).find(
              (tab) =>
                tab.id === activeUnifiedTabId && (!activeGroup || tab.groupId === activeGroup.id)
            ) ?? null)
          : null
      const fileStillOpen = restoredFileId
        ? s.openFiles.some((file) => file.id === restoredFileId && file.worktreeId === workspaceKey)
        : false
      const browserTabs = s.browserTabsByWorktree[workspaceKey] ?? []
      const browserTabStillOpen = restoredBrowserTabId
        ? browserTabs.some((tab) => tab.id === restoredBrowserTabId)
        : false
      const worktreeTabs = s.tabsByWorktree[workspaceKey] ?? []
      const restoredTabId = s.activeTabIdByWorktree[workspaceKey] ?? null
      const tabStillExists = restoredTabId
        ? worktreeTabs.some((tab) => tab.id === restoredTabId)
        : false
      const activeFileId =
        activeUnifiedTab?.contentType === 'editor' ||
        activeUnifiedTab?.contentType === 'diff' ||
        activeUnifiedTab?.contentType === 'conflict-review' ||
        activeUnifiedTab?.contentType === 'check-details'
          ? activeUnifiedTab.entityId
          : fileStillOpen
            ? restoredFileId
            : null
      const activeBrowserTabId =
        activeUnifiedTab?.contentType === 'browser'
          ? activeUnifiedTab.entityId
          : browserTabStillOpen
            ? restoredBrowserTabId
            : (browserTabs[0]?.id ?? null)
      const activeTabType =
        activeUnifiedTab?.contentType === 'terminal'
          ? 'terminal'
          : activeUnifiedTab?.contentType === 'browser'
            ? 'browser'
            : activeUnifiedTab
              ? 'editor'
              : restoredTabType === 'browser' && browserTabStillOpen
                ? 'browser'
                : restoredTabType === 'editor' && fileStillOpen
                  ? 'editor'
                  : fileStillOpen
                    ? 'editor'
                    : browserTabs.length > 0
                      ? 'browser'
                      : 'terminal'
      const activeTabId =
        activeUnifiedTab?.contentType === 'terminal'
          ? activeUnifiedTab.entityId
          : tabStillExists
            ? restoredTabId
            : (worktreeTabs[0]?.id ?? null)
      const nextEverActivated = s.everActivatedWorktreeIds.has(workspaceKey)
        ? s.everActivatedWorktreeIds
        : new Set([...s.everActivatedWorktreeIds, workspaceKey])
      return {
        activeRepoId: null,
        activeWorktreeId: workspaceKey,
        activeWorkspaceKey: workspaceKey,
        activeWorkspaceExecutionHostId: executionHostId ?? null,
        activePendingCreationId: null,
        activeFileId,
        activeBrowserTabId,
        activeTabType,
        activeTabTypeByWorktree:
          s.activeTabTypeByWorktree[workspaceKey] === activeTabType
            ? s.activeTabTypeByWorktree
            : { ...s.activeTabTypeByWorktree, [workspaceKey]: activeTabType },
        activeTabId,
        everActivatedWorktreeIds: nextEverActivated,
        folderWorkspaces: workspace.isUnread
          ? s.folderWorkspaces.map((entry) =>
              entry.id === folderWorkspaceId &&
              (!executionHostId || folderWorkspaceMatchesHost(entry, executionHostId))
                ? { ...entry, isUnread: false }
                : entry
            )
          : s.folderWorkspaces
      }
    })
    if (workspace.isUnread) {
      void get().updateFolderWorkspace(
        folderWorkspaceId,
        { isUnread: false },
        executionHostId ? { executionHostId } : undefined
      )
    }
  }
}
