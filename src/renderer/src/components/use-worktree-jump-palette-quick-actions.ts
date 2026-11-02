import { useCallback, useMemo } from 'react'
import { useAppStore } from '@/store'
import { runWorktreeDelete } from '@/components/sidebar/delete-worktree-flow'
import {
  buildCmdJQuickActionContext,
  getUnavailableQuickActionMessage
} from '@/components/cmd-j/quick-action-context'
import { rankCmdJMiddleResults } from '@/components/cmd-j/palette-results'
import { buildCmdJBrowserNavigationAction } from '@/components/cmd-j/browser-navigation-action'
import { openWorkspaceBrowserTab } from '@/lib/workspace-browser-tab-open'
import { findGroupAndWorktree } from '@/store/slices/tab-group-state'
import {
  getComposerEligibleRepos,
  resolveComposerActiveRepoId,
  resolveComposerGitRepoId
} from '@/lib/new-workspace-composer-repo'
import type { QuickActionPaletteItem, SettingsPaletteItem } from './worktree-jump-palette-model'
import type { WorktreeJumpPaletteLocalState } from './use-worktree-jump-palette-local-state'
import type { WorktreeJumpPaletteOpenTabs } from './use-worktree-jump-palette-open-tabs'
import type { WorktreeJumpPaletteProjectTargets } from './use-worktree-jump-palette-project-targets'
import type { WorktreeJumpPaletteStoreState } from './use-worktree-jump-palette-store-state'
import type { WorktreeJumpPaletteWorktrees } from './use-worktree-jump-palette-worktrees'

function getComposerPrefetchRepoId(
  state: ReturnType<typeof useAppStore.getState>,
  initialRepoId?: string
): string | null {
  return resolveComposerGitRepoId({
    eligibleRepos: getComposerEligibleRepos(state.repos),
    initialRepoId,
    activeRepoId: resolveComposerActiveRepoId(
      state.repos,
      getComposerEligibleRepos(state.repos),
      state.activeRepoId
    ),
    focusedHostScope: state.workspaceHostScope
  })
}

type WorktreeJumpPaletteQuickActionsInput = WorktreeJumpPaletteStoreState &
  Pick<WorktreeJumpPaletteLocalState, 'activeGroupSnapshotRef' | 'deferredQuery'> &
  WorktreeJumpPaletteProjectTargets &
  Pick<WorktreeJumpPaletteWorktrees, 'isLoading'> &
  Pick<WorktreeJumpPaletteOpenTabs, never>

export function useWorktreeJumpPaletteQuickActions({
  openModal,
  openSettingsPage,
  openSettingsTarget,
  activeGroupSnapshotRef,
  openNewBrowserTabInActiveWorkspace,
  openNewMarkdownInActiveWorkspace,
  openNewTerminalTabInActiveWorkspace,
  actionResults,
  activeView,
  activeWorktreeId,
  worktreesByRepo,
  repos,
  sshConnectionStates,
  activeGroupIdByWorktree,
  groupsByWorktree,
  unifiedTabsByWorktree,
  isLoading,
  settings,
  runtimeStatusByEnvironmentId,
  deferredQuery,
  settingsResults
}: WorktreeJumpPaletteQuickActionsInput) {
  const prefetchCreateWorkspaceBaseForComposer = useCallback((initialRepoId?: string): void => {
    const state = useAppStore.getState()
    const repoIdForComposer = getComposerPrefetchRepoId(state, initialRepoId)
    if (!repoIdForComposer) {
      return
    }
    void state.prefetchWorktreeCreateBase(repoIdForComposer)
  }, [])
  const openCreateWorkspaceAction = useCallback(() => {
    prefetchCreateWorkspaceBaseForComposer()
    queueMicrotask(() =>
      openModal('new-workspace-composer', { telemetrySource: 'command_palette' })
    )
  }, [openModal, prefetchCreateWorkspaceBaseForComposer])
  const deleteActiveWorkspaceAction = useCallback(() => {
    const {
      activeView: currentView,
      activeWorktreeId: currentWorktreeId,
      activeWorkspaceExecutionHostId
    } = useAppStore.getState()
    if (currentView !== 'terminal' || !currentWorktreeId) {
      return
    }
    queueMicrotask(() =>
      runWorktreeDelete(
        currentWorktreeId,
        activeWorkspaceExecutionHostId ? { expectedHostId: activeWorkspaceExecutionHostId } : {}
      )
    )
  }, [])
  const openBrowserUrlAction = useCallback(async (groupId: string, url: string) => {
    const state = useAppStore.getState()
    // Why: the invoking group owns its workspace, as for New Browser Tab.
    const workspaceId =
      findGroupAndWorktree(state.groupsByWorktree, groupId)?.worktreeId ?? state.activeWorktreeId
    if (!workspaceId) {
      return
    }
    await openWorkspaceBrowserTab({
      workspaceId,
      targetGroupId: groupId,
      url,
      intent: { kind: 'url' }
    })
  }, [])
  const openAddQuickCommandAction = useCallback(() => {
    openSettingsTarget({ pane: 'quick-commands', repoId: null, intent: 'add-quick-command' })
    openSettingsPage()
  }, [openSettingsPage, openSettingsTarget])
  const buildQuickActionContext = useCallback(
    () =>
      buildCmdJQuickActionContext({
        state: useAppStore.getState(),
        activeGroupSnapshot: activeGroupSnapshotRef.current,
        openNewBrowserTab: openNewBrowserTabInActiveWorkspace,
        openBrowserUrl: openBrowserUrlAction,
        openNewMarkdownFile: openNewMarkdownInActiveWorkspace,
        openNewTerminalTab: openNewTerminalTabInActiveWorkspace,
        openCreateWorkspace: openCreateWorkspaceAction,
        deleteActiveWorkspace: deleteActiveWorkspaceAction,
        openAddQuickCommand: openAddQuickCommandAction
      }),
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- the controller ref preserves its original stable identity.
    [
      deleteActiveWorkspaceAction,
      openAddQuickCommandAction,
      openBrowserUrlAction,
      openCreateWorkspaceAction,
      openNewBrowserTabInActiveWorkspace,
      openNewMarkdownInActiveWorkspace,
      openNewTerminalTabInActiveWorkspace
    ]
  )
  // Why: buildQuickActionContext() reads the store imperatively, so these voided values are the
  // memo's real inputs — each one is read (some transitively, e.g. runtimeStatusByEnvironmentId
  // via the managed-browser creation policy) while availability is computed.
  const availableActions = useMemo(() => {
    void activeView
    void activeWorktreeId
    void worktreesByRepo
    void repos
    void sshConnectionStates
    void activeGroupIdByWorktree
    void groupsByWorktree
    void unifiedTabsByWorktree
    void isLoading
    void settings?.activeRuntimeEnvironmentId
    void runtimeStatusByEnvironmentId
    const context = buildQuickActionContext()
    return {
      context,
      actionResults: actionResults.filter((action) => action.isAvailable(context).available)
    }
  }, [
    actionResults,
    buildQuickActionContext,
    activeView,
    activeWorktreeId,
    worktreesByRepo,
    repos,
    sshConnectionStates,
    activeGroupIdByWorktree,
    groupsByWorktree,
    unifiedTabsByWorktree,
    isLoading,
    settings?.activeRuntimeEnvironmentId,
    runtimeStatusByEnvironmentId
  ])
  const middleItems = useMemo<(SettingsPaletteItem | QuickActionPaletteItem)[]>(() => {
    const results = rankCmdJMiddleResults({
      query: deferredQuery,
      settingsResults,
      actionResults: availableActions.actionResults
    })
    const navigationAction = buildCmdJBrowserNavigationAction(deferredQuery)
    if (navigationAction?.isAvailable(availableActions.context).available) {
      results.unshift({ ...navigationAction, order: 0, qualityClass: 'exact-intent' })
    }
    return results.map((result) =>
      result.kind === 'settings'
        ? { id: result.id, type: 'settings' as const, result }
        : { id: `quick-action:${result.id}`, type: 'quick-action' as const, result }
    )
  }, [availableActions, deferredQuery, settingsResults])
  return { prefetchCreateWorkspaceBaseForComposer, buildQuickActionContext, middleItems }
}

export { getUnavailableQuickActionMessage }
export type WorktreeJumpPaletteQuickActions = ReturnType<typeof useWorktreeJumpPaletteQuickActions>
