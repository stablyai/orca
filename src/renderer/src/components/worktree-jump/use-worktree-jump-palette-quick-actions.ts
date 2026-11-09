import {
  useGitGraphScope,
  gitGraphSupport,
  gitGraphUpdateMessage,
  probeGitGraphSupport
} from '@/lib/git-graph-tab'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAppStore } from '@/store/index'
import { runWorktreeDelete } from '@/components/sidebar/workspace-actions/deletion/delete-worktree-flow'
import { buildCmdJQuickActionContext } from '@/components/cmd-j/quick-action-context'
import { rankCmdJMiddleResults } from '@/components/cmd-j/palette-results'
import { buildCmdJBrowserNavigationAction } from '@/components/cmd-j/browser-navigation-action'
import { openWorkspaceBrowserTab } from '@/lib/browser/workspace/workspace-browser-tab-open'
import { findGroupAndWorktree } from '@/store/slices/tabs/tab-group-state'
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
import { recomputeOn } from '@/lib/recompute-on'

/** Prefetch the repo New workspace will seed, mapping a per-workspace VM repo to its visible checkout. */
function getComposerPrefetchRepoId(
  state: ReturnType<typeof useAppStore.getState>,
  initialRepoId?: string
): string | null {
  const eligibleRepos = getComposerEligibleRepos(state.repos)
  return resolveComposerGitRepoId({
    eligibleRepos,
    initialRepoId,
    activeRepoId: resolveComposerActiveRepoId(
      state.repos,
      eligibleRepos,
      state.activeRepoId,
      state.runtimeEnvironments
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
  const graphScope = useGitGraphScope(activeWorktreeId ?? '')
  const graphOwner = JSON.stringify([activeWorktreeId, graphScope?.route])
  const [graphProbe, setGraphProbe] = useState<{ owner: string; support: boolean | null }>()
  const graphSupport = graphProbe?.owner === graphOwner ? graphProbe.support : null
  useEffect(() => {
    let live = true
    if (activeWorktreeId) {
      setGraphProbe({ owner: graphOwner, support: gitGraphSupport(activeWorktreeId) })
      void probeGitGraphSupport(activeWorktreeId)
        .then((value) => {
          if (live) {
            setGraphProbe({ owner: graphOwner, support: value })
          }
        })
        .catch(() => {})
    }
    return () => {
      live = false
    }
  }, [activeWorktreeId, graphOwner, runtimeStatusByEnvironmentId])
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
    [
      activeGroupSnapshotRef,
      deleteActiveWorkspaceAction,
      openAddQuickCommandAction,
      openBrowserUrlAction,
      openCreateWorkspaceAction,
      openNewBrowserTabInActiveWorkspace,
      openNewMarkdownInActiveWorkspace,
      openNewTerminalTabInActiveWorkspace
    ]
  )
  // Availability reads store state imperatively; these values supply its real memo dependencies, including managed-browser runtime status.
  const availableActions = useMemo(
    () =>
      recomputeOn(
        [
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
        ],
        () => {
          const context = buildQuickActionContext()
          return {
            context,
            actionResults: actionResults
              .filter(
                (action) =>
                  (action.id === 'git-graph' &&
                    context.activeWorktree &&
                    repos.find((repo) => repo.id === context.activeWorktree?.repoId)?.kind !==
                      'folder') ||
                  action.isAvailable(context).available
              )
              .map((action) =>
                action.id === 'git-graph'
                  ? {
                      ...action,
                      disabled: graphSupport !== true,
                      description:
                        graphSupport === false && activeWorktreeId
                          ? gitGraphUpdateMessage(activeWorktreeId)
                          : ''
                    }
                  : action
              )
          }
        }
      ),
    [
      graphSupport,
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
    ]
  )
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

export type WorktreeJumpPaletteQuickActions = ReturnType<typeof useWorktreeJumpPaletteQuickActions>
