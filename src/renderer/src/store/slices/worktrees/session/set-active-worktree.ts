import type { WorktreeSlice } from '../../worktree-helpers'
import type { WorktreeSliceGet, WorktreeSliceSet } from '../listing/worktree-slice-types'
import type { AppState } from '../../../types'
import type { WorktreeMeta } from '../../../../../../shared/worktree/meta-types'
import { applyWorktreeUpdates } from '../../worktree-helpers'
import { projectWorktreeTabModelReconciliation } from '../../tabs'
import { moveFocusToRendererBeforeFocusedWebviewHidden } from '../../browser-webview-cleanup'
import { tabHasLivePty } from '@/lib/tab-has-live-pty'
import { markInputQuietSchedulerInput } from '@/lib/input-quiet-scheduler'
import { getTerminalActivationSpawnSuppression } from '../../terminal-activation-spawn-suppression'
import {
  isWorkspaceKey,
  parseWorkspaceKey,
  worktreeWorkspaceKey
} from '../../../../../../shared/workspace-scope'
import {
  applyDetectedWorktreeUpdates,
  findKnownWorktreeById,
  hasCatalogWorktreeById
} from '../listing/detected-worktree-meta'
import { persistPassiveWorktreeMetaForOwner } from '../listing/worktree-owner-settings'
import { resolveActivatedWorktreeSurface } from './active-worktree-surface'
import { clearWorktreeSleepIntent } from '@/lib/worktree-sleep-intent'
import {
  worktreeSelectionOwnerKey,
  getActiveWorktreeOwner,
  withAvailableWorktreeSelectionInstance
} from '@/lib/worktree-selection-owner'
import {
  prepareActivationTerminalTabs,
  shouldDeferActivationTerminalPrep
} from './activation-terminal-prep'

export function createSetActiveWorktree(
  set: WorktreeSliceSet,
  get: WorktreeSliceGet
): WorktreeSlice['setActiveWorktree'] {
  return (worktreeId, executionHostId, options) => {
    const stateTransition = options?.stateTransition?.(get())
    const createdTabIds = new Set(options?.createdTabIds)
    // A tab its caller just created is not asleep: its first bind is new work, not a wake.
    const isWakeable = (tab: { id: string }): boolean => !createdTabIds.has(tab.id)
    if (stateTransition && !stateTransition.activate) {
      if (Object.keys(stateTransition.patch).length > 0) {
        set(stateTransition.patch)
      }
      return false
    }
    const workspaceScope = worktreeId ? parseWorkspaceKey(worktreeId) : null
    if (worktreeId && shouldDeferActivationTerminalPrep()) {
      markInputQuietSchedulerInput()
    }

    let selectedOwner = options?.owner ?? getActiveWorktreeOwner(get(), worktreeId, executionHostId)
    const selectedHostId = executionHostId ?? selectedOwner?.executionHostId ?? null
    let accepted = false
    let shouldClearUnread = false
    let shouldPrepareTerminalTabs = false
    let shouldTagTerminalTabs = false
    set((current) => {
      const worktree = worktreeId
        ? findKnownWorktreeById(current, worktreeId, executionHostId, selectedOwner)
        : undefined
      if (
        worktreeId &&
        !worktree &&
        (selectedOwner || hasCatalogWorktreeById(current, worktreeId))
      ) {
        return current
      }
      selectedOwner = withAvailableWorktreeSelectionInstance(selectedOwner, worktree)
      accepted = true
      if (current.activeWorktreeId !== worktreeId) {
        moveFocusToRendererBeforeFocusedWebviewHidden()
      }
      const transitioned = stateTransition
        ? ({ ...current, ...stateTransition.patch } as AppState)
        : current
      const reconciliation = worktreeId
        ? projectWorktreeTabModelReconciliation(transitioned, worktreeId)
        : null
      const reconciliationChanged = Boolean(
        reconciliation && Object.keys(reconciliation.patch).length > 0
      )
      const s =
        reconciliation && reconciliationChanged
          ? ({ ...transitioned, ...reconciliation.patch } as AppState)
          : transitioned
      const reconciledActiveTabId = reconciliation?.activeRenderableTabId ?? null
      if (!worktreeId) {
        return {
          ...stateTransition?.patch,
          activeWorktreeId: null,
          activeWorkspaceKey: null,
          activeWorkspaceExecutionHostId: null,
          activeWorkspaceOwner: null,
          // Why: clearing/activating a worktree must dismiss the background-creation panel so the user isn't stranded on it.
          activePendingCreationId: null
        }
      }

      shouldClearUnread = Boolean(worktree?.isUnread)
      const {
        restoredRightSidebarExplorerView,
        activeFileId,
        activeBrowserTabId,
        activeTabType,
        activeTabId
      } = resolveActivatedWorktreeSurface(
        s,
        worktreeId,
        stateTransition?.preferredActiveUnifiedTabId,
        reconciledActiveTabId
      )

      // Why: focus isn't smart-sort activity — writing lastActivityAt here caused the "jump after focus" bug; only clear unread.
      const metaUpdates: Partial<WorktreeMeta> = shouldClearUnread ? { isUnread: false } : {}

      // Why: prep is deferred (shell render deferred below) so it waits for input quiet instead of blocking the click.
      // Why first-activation guard, not tab.ptyId==null: reconnectPersistedTerminals repopulates ptyId before mount.
      // Tag every tab on FIRST activation so reattach/fresh-spawn updateTabPtyId suppresses activity + sortEpoch bumps.
      // Generation is only bumped when no tab has a live PTY — a live remount would kill the user's shell.
      const tabs = s.tabsByWorktree[worktreeId ?? ''] ?? []
      const wakeable = tabs.filter(isWakeable)
      const allDead =
        worktreeId != null &&
        wakeable.length > 0 &&
        wakeable.every((tab) => !tabHasLivePty(s.ptyIdsByTabId, tab.id))
      const isFirstActivation = worktreeId != null && !s.everActivatedWorktreeIds.has(worktreeId)
      const shouldTagTabs = worktreeId != null && wakeable.length > 0 && isFirstActivation
      // Why: bump generation in the same set() as activation so a dead-transport pane can't go visible-but-dead before remount.
      shouldPrepareTerminalTabs = Boolean(
        worktreeId && wakeable.length > 0 && shouldTagTabs && !allDead
      )
      shouldTagTerminalTabs = shouldTagTabs
      const nextEverActivated = isFirstActivation
        ? new Set([...s.everActivatedWorktreeIds, worktreeId!])
        : s.everActivatedWorktreeIds
      const nextWorktrees = shouldClearUnread
        ? applyWorktreeUpdates(s.worktreesByRepo, worktreeId, metaUpdates)
        : s.worktreesByRepo
      const nextDetectedWorktrees = shouldClearUnread
        ? applyDetectedWorktreeUpdates(s.detectedWorktreesByRepo, worktreeId, metaUpdates)
        : s.detectedWorktreesByRepo
      const nextFolderWorkspaces =
        shouldClearUnread && workspaceScope?.type === 'folder'
          ? s.folderWorkspaces.map((workspace) =>
              workspace.id === workspaceScope.folderWorkspaceId
                ? { ...workspace, isUnread: false }
                : workspace
            )
          : s.folderWorkspaces
      const nextActiveRepoId =
        workspaceScope?.type === 'folder'
          ? null
          : stateTransition
            ? (worktree?.repoId ?? s.activeRepoId)
            : s.activeRepoId
      const tabsByWorktreeUpdate =
        allDead && worktreeId != null
          ? {
              tabsByWorktree: {
                ...s.tabsByWorktree,
                [worktreeId]: tabs.map((tab) =>
                  !isWakeable(tab)
                    ? tab
                    : {
                        ...tab,
                        generation: (tab.generation ?? 0) + 1,
                        pendingActivationSpawn: getTerminalActivationSpawnSuppression(
                          s.terminalLayoutsByTabId[tab.id]
                        )
                      }
                )
              }
            }
          : {}

      const nextActiveTabTypeByWorktree =
        s.activeTabTypeByWorktree[worktreeId] === activeTabType
          ? s.activeTabTypeByWorktree
          : { ...s.activeTabTypeByWorktree, [worktreeId]: activeTabType }
      const hasStateChange =
        s.activeWorktreeId !== worktreeId ||
        s.activeWorkspaceExecutionHostId !== selectedHostId ||
        worktreeSelectionOwnerKey(s.activeWorkspaceOwner) !==
          worktreeSelectionOwnerKey(selectedOwner) ||
        // Why: a pending-creation panel can show over the prior worktree; a non-null activePendingCreationId counts as a change.
        s.activePendingCreationId !== null ||
        s.activeFileId !== activeFileId ||
        s.activeBrowserTabId !== activeBrowserTabId ||
        s.activeTabType !== activeTabType ||
        s.rightSidebarExplorerView !== restoredRightSidebarExplorerView ||
        s.activeTabId !== activeTabId ||
        nextActiveTabTypeByWorktree !== s.activeTabTypeByWorktree ||
        nextEverActivated !== s.everActivatedWorktreeIds ||
        nextWorktrees !== s.worktreesByRepo ||
        nextDetectedWorktrees !== s.detectedWorktreesByRepo ||
        nextFolderWorkspaces !== s.folderWorkspaces ||
        nextActiveRepoId !== s.activeRepoId ||
        reconciliationChanged ||
        stateTransition !== undefined
      if (!hasStateChange) {
        // Why: preserve the root Zustand reference on a no-op re-activation so session persistence/runtime sync don't fan out.
        return s
      }

      return {
        ...stateTransition?.patch,
        ...reconciliation?.patch,
        activeRepoId: nextActiveRepoId,
        activeWorktreeId: worktreeId,
        activeWorkspaceKey: isWorkspaceKey(worktreeId)
          ? worktreeId
          : worktreeWorkspaceKey(worktreeId),
        activeWorkspaceExecutionHostId: selectedHostId,
        activeWorkspaceOwner: selectedOwner ? { ...selectedOwner } : null,
        activePendingCreationId: null,
        activeFileId,
        activeBrowserTabId,
        activeTabType,
        activeTabTypeByWorktree: nextActiveTabTypeByWorktree,
        rightSidebarExplorerView: restoredRightSidebarExplorerView,
        activeTabId,
        everActivatedWorktreeIds: nextEverActivated,
        ...(nextWorktrees !== s.worktreesByRepo ? { worktreesByRepo: nextWorktrees } : {}),
        ...(nextDetectedWorktrees !== s.detectedWorktreesByRepo
          ? { detectedWorktreesByRepo: nextDetectedWorktrees }
          : {}),
        ...(nextFolderWorkspaces !== s.folderWorkspaces
          ? { folderWorkspaces: nextFolderWorkspaces }
          : {}),
        ...tabsByWorktreeUpdate
      }
    })
    if (!accepted) {
      return false
    }

    // Why: any activation is an explicit wake (null is the sleep flow clearing selection).
    // Cleared after the set() above so a pane still waiting on the marker connects once,
    // in the remounted generation, instead of connecting and then being remounted.
    clearWorktreeSleepIntent(worktreeId)

    if (worktreeId && shouldPrepareTerminalTabs) {
      prepareActivationTerminalTabs(
        set,
        worktreeId,
        selectedOwner,
        isWakeable,
        shouldTagTerminalTabs
      )
    }

    // Why: activation is explicit enough to revalidate PR state now; the coordinator still coalesces and rate-guards.
    if (worktreeId) {
      get().refreshGitHubForWorktreeIfStale(worktreeId)
    }

    if (!worktreeId || !get().getKnownWorktreeById(worktreeId, executionHostId)) {
      return true
    }

    if (shouldClearUnread) {
      if (workspaceScope?.type === 'folder') {
        void get().updateFolderWorkspace(workspaceScope.folderWorkspaceId, { isUnread: false })
        return true
      }
      persistPassiveWorktreeMetaForOwner(
        get,
        worktreeId,
        { isUnread: false },
        'persist worktree activation state'
      )
    }
    return true
  }
}
