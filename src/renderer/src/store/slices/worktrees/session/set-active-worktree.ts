import type { WorktreeSlice } from '../../worktree-helpers'
import type { WorktreeSliceGet, WorktreeSliceSet } from '../listing/worktree-slice-types'
import type { AppState } from '../../../types'
import type { WorktreeMeta } from '../../../../../../shared/worktree/meta-types'
import { applyWorktreeUpdates } from '../../worktree-helpers'
import { projectWorktreeTabModelReconciliation } from '../../tabs'
import { moveFocusToRendererBeforeFocusedWebviewHidden } from '../../browser-webview-cleanup'
import { tabHasLivePty } from '@/lib/tab-has-live-pty'
import { markInputQuietSchedulerInput, scheduleAfterInputQuiet } from '@/lib/input-quiet-scheduler'
import {
  ACTIVE_WORKTREE_TERMINAL_PREP_DELAY_MS,
  ACTIVE_WORKTREE_TERMINAL_PREP_IDLE_TIMEOUT_MS,
  ACTIVE_WORKTREE_TERMINAL_PREP_INPUT_QUIET_MS
} from '../listing/worktree-slice-constants'
import { getTerminalActivationSpawnSuppression } from '../../terminal-activation-spawn-suppression'
import {
  isWorkspaceKey,
  parseWorkspaceKey,
  worktreeWorkspaceKey
} from '../../../../../../shared/workspace-scope'
import {
  applyDetectedWorktreeUpdates,
  findKnownWorktreeById
} from '../listing/detected-worktree-meta'
import { persistPassiveWorktreeMetaForOwner } from '../listing/worktree-owner-settings'
import { resolveActivatedWorktreeSurface } from './active-worktree-surface'
import {
  pendingActivationTerminalPrepCancels,
  shouldDeferActivationTerminalPrep
} from './activation-terminal-prep'

export function createSetActiveWorktree(
  set: WorktreeSliceSet,
  get: WorktreeSliceGet
): WorktreeSlice['setActiveWorktree'] {
  return (worktreeId, executionHostId, options) => {
    const stateTransition = options?.stateTransition?.(get())
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

    if (get().activeWorktreeId !== worktreeId) {
      moveFocusToRendererBeforeFocusedWebviewHidden()
    }
    let shouldClearUnread = false
    let shouldPrepareTerminalTabs = false
    let shouldTagTerminalTabs = false
    set((current) => {
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
          // Why: clearing/activating a worktree must dismiss the background-creation panel so the user isn't stranded on it.
          activePendingCreationId: null
        }
      }

      const worktree = findKnownWorktreeById(s, worktreeId, executionHostId)
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
      const allDead =
        worktreeId != null &&
        tabs.length > 0 &&
        tabs.every((tab) => !tabHasLivePty(s.ptyIdsByTabId, tab.id))
      const isFirstActivation = worktreeId != null && !s.everActivatedWorktreeIds.has(worktreeId)
      const shouldTagTabs = worktreeId != null && tabs.length > 0 && isFirstActivation
      // Why: bump generation in the same set() as activation so a dead-transport pane can't go visible-but-dead before remount.
      shouldPrepareTerminalTabs = Boolean(
        worktreeId && tabs.length > 0 && shouldTagTabs && !allDead
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
                [worktreeId]: tabs.map((tab) => ({
                  ...tab,
                  generation: (tab.generation ?? 0) + 1,
                  pendingActivationSpawn: getTerminalActivationSpawnSuppression(
                    s.terminalLayoutsByTabId[tab.id]
                  )
                }))
              }
            }
          : {}

      const nextActiveTabTypeByWorktree =
        s.activeTabTypeByWorktree[worktreeId] === activeTabType
          ? s.activeTabTypeByWorktree
          : { ...s.activeTabTypeByWorktree, [worktreeId]: activeTabType }
      const hasStateChange =
        s.activeWorktreeId !== worktreeId ||
        s.activeWorkspaceExecutionHostId !== (executionHostId ?? null) ||
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
        activeWorkspaceExecutionHostId: executionHostId ?? null,
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

    if (worktreeId && shouldPrepareTerminalTabs) {
      const prepareTerminalTabs = (): void => {
        pendingActivationTerminalPrepCancels.delete(worktreeId)
        set((s) => {
          if (s.activeWorktreeId !== worktreeId) {
            return {}
          }
          const tabs = s.tabsByWorktree[worktreeId] ?? []
          if (tabs.length === 0) {
            return {}
          }
          const allDead = tabs.every((tab) => !tabHasLivePty(s.ptyIdsByTabId, tab.id))
          if (!allDead && !shouldTagTerminalTabs) {
            return {}
          }
          return {
            tabsByWorktree: {
              ...s.tabsByWorktree,
              [worktreeId]: tabs.map((tab) => ({
                ...tab,
                ...(allDead ? { generation: (tab.generation ?? 0) + 1 } : {}),
                // Why: slept terminal remount/spawn is click-driven wake work; tag its PTY updates so they don't reshuffle Recent.
                pendingActivationSpawn: getTerminalActivationSpawnSuppression(
                  s.terminalLayoutsByTabId[tab.id]
                )
              }))
            }
          }
        })
      }

      const cancelExistingPrep = pendingActivationTerminalPrepCancels.get(worktreeId)
      if (cancelExistingPrep) {
        cancelExistingPrep()
      }
      if (shouldDeferActivationTerminalPrep()) {
        pendingActivationTerminalPrepCancels.set(
          worktreeId,
          scheduleAfterInputQuiet(prepareTerminalTabs, {
            delayMs: ACTIVE_WORKTREE_TERMINAL_PREP_DELAY_MS,
            quietMs: ACTIVE_WORKTREE_TERMINAL_PREP_INPUT_QUIET_MS,
            idleTimeoutMs: ACTIVE_WORKTREE_TERMINAL_PREP_IDLE_TIMEOUT_MS
          })
        )
      } else {
        prepareTerminalTabs()
      }
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
