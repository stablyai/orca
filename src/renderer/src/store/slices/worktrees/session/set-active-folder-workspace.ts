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
import { deriveActiveSurfaceForWorktree } from '../../tabs/tabs-surface'

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
      const { activeFileId, activeBrowserTabId, activeTabType, activeTabId } =
        deriveActiveSurfaceForWorktree(s, workspaceKey, undefined, {
          legacySelection: 'remembered-type',
          preferredTabId: reconciledActiveTabId ?? undefined
        })
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
