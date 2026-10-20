import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { usePluginCommands } from '@/store/plugin-panels'
import { useSettingsNavigationMetadata } from '@/hooks/useSettingsNavigationMetadata'
import { dedupePaletteWorktrees } from '@/lib/palette-repo-resolution'
import { getFolderWorkspaceWorktree } from '@/store/slices/worktrees/listing/detected-worktree-meta'
import {
  selectPaletteIndexStatusSnapshot,
  selectPaletteStatusInputs
} from './worktree-jump-palette-status-inputs'
import { selectWorktreePaletteCacheInputs } from '@/components/cmd-j/worktree-palette-cache-inputs'
import {
  getConcealedRepoIdsFromState,
  getShownReposFromState,
  omitConcealedRepoKeys
} from '@/store/concealed-repo-selector'

export function useWorktreeJumpPaletteStoreState({
  visible,
  lingering
}: {
  visible: boolean
  lingering: boolean
}) {
  useTranslation()
  // Freeze age labels for one palette session; live status dots own their clock separately.
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- visibility intentionally starts a new session clock.
  const paletteNowMs = useMemo(() => Date.now(), [visible])
  const closeModal = useAppStore((state) => state.closeModal)
  const openModal = useAppStore((state) => state.openModal)
  const openSettingsPage = useAppStore((state) => state.openSettingsPage)
  const openSettingsTarget = useAppStore((state) => state.openSettingsTarget)
  const recordFeatureInteraction = useAppStore((state) => state.recordFeatureInteraction)
  const revealSidebarRow = useAppStore((state) => state.revealSidebarRow)
  // Why filter at the source: search deliberately bypasses sidebar filters, but never incognito.
  const concealedRepoIds = useAppStore(getConcealedRepoIdsFromState)
  const allWorktreesByRepo = useAppStore((state) => state.worktreesByRepo)
  const worktreesByRepo = useMemo<AppState['worktreesByRepo']>(
    () => omitConcealedRepoKeys(allWorktreesByRepo, concealedRepoIds),
    [allWorktreesByRepo, concealedRepoIds]
  )
  const folderWorkspaces = useAppStore((state) => state.folderWorkspaces)
  const workspaces = useMemo(
    () =>
      dedupePaletteWorktrees([
        ...Object.values(worktreesByRepo).flat(),
        ...folderWorkspaces.map(getFolderWorkspaceWorktree)
      ]),
    [folderWorkspaces, worktreesByRepo]
  )
  const repos = useAppStore(getShownReposFromState)
  const projectGroups = useAppStore((state) => state.projectGroups)
  const allProjects = useAppStore((state) => state.projects)
  const projects = useMemo<AppState['projects']>(
    () =>
      concealedRepoIds.size === 0
        ? allProjects
        : allProjects.filter(
            (project) =>
              project.sourceRepoIds.length === 0 ||
              project.sourceRepoIds.some((repoId) => !concealedRepoIds.has(repoId))
          ),
    [allProjects, concealedRepoIds]
  )
  const allProjectHostSetups = useAppStore((state) => state.projectHostSetups)
  const projectHostSetups = useMemo<AppState['projectHostSetups']>(
    () =>
      concealedRepoIds.size === 0
        ? allProjectHostSetups
        : allProjectHostSetups.filter((setup) => !concealedRepoIds.has(setup.repoId)),
    [allProjectHostSetups, concealedRepoIds]
  )
  const allDetectedWorktreesByRepo = useAppStore((state) => state.detectedWorktreesByRepo)
  const detectedWorktreesByRepo = useMemo<AppState['detectedWorktreesByRepo']>(
    () => omitConcealedRepoKeys(allDetectedWorktreesByRepo, concealedRepoIds),
    [allDetectedWorktreesByRepo, concealedRepoIds]
  )
  const pendingWorktreeCreations = useAppStore((state) => state.pendingWorktreeCreations)
  const pluginCommands = usePluginCommands()
  const paletteStatusInputsActive = visible || lingering
  const { ptyIdsByTabId, terminalLayoutsByTabId, tabsByWorktree } = useAppStore(
    useShallow((state) => selectPaletteStatusInputs(state, paletteStatusInputsActive))
  )
  const { prCache, issueCache, hostedReviewCache } = useAppStore(
    useShallow((state) => selectWorktreePaletteCacheInputs(state, paletteStatusInputsActive))
  )
  const migrationUnsupportedByPtyId = useAppStore((state) => state.migrationUnsupportedByPtyId)
  const activeView = useAppStore((state) => state.activeView)
  const activeWorktreeId = useAppStore((state) => state.activeWorktreeId)
  const activeWorkspaceExecutionHostId = useAppStore(
    (state) => state.activeWorkspaceExecutionHostId
  )
  const activeTabType = useAppStore((state) => state.activeTabType)
  const activeTabId = useAppStore((state) => state.activeTabId)
  const activeTabIdByWorktree = useAppStore((state) => state.activeTabIdByWorktree)
  const activeFileId = useAppStore((state) => state.activeFileId)
  const activeFileIdByWorktree = useAppStore((state) => state.activeFileIdByWorktree)
  const activeTabTypeByWorktree = useAppStore((state) => state.activeTabTypeByWorktree)
  const activeBrowserTabId = useAppStore((state) => state.activeBrowserTabId)
  const browserTabsByWorktree = useAppStore((state) => state.browserTabsByWorktree)
  const browserPagesByWorkspace = useAppStore((state) => state.browserPagesByWorkspace)
  const unifiedTabsByWorktree = useAppStore((state) => state.unifiedTabsByWorktree)
  const paletteIndexStatus = useMemo(
    () => selectPaletteIndexStatusSnapshot(useAppStore.getState(), paletteStatusInputsActive),
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- these deps are the snapshot refresh policy.
    [paletteStatusInputsActive, tabsByWorktree, unifiedTabsByWorktree]
  )
  const {
    agentStatusByPaneKey,
    runtimePaneTitlesByTabId,
    unreadTerminalTabs,
    unreadAgentCompletionPanes
  } = paletteIndexStatus
  const openFiles = useAppStore((state) => state.openFiles)
  const activeGroupIdByWorktree = useAppStore((state) => state.activeGroupIdByWorktree)
  const groupsByWorktree = useAppStore((state) => state.groupsByWorktree)
  const retainedAgentsByPaneKey = useAppStore((state) => state.retainedAgentsByPaneKey)
  const sleepingAgentSessionsByPaneKey = useAppStore(
    (state) => state.sleepingAgentSessionsByPaneKey
  )
  const paneForegroundAgentByPaneKey = useAppStore((state) => state.paneForegroundAgentByPaneKey)
  const settings = useAppStore((state) => state.settings)
  const worktreeVisibilityDefaultsByHost = useAppStore(
    (state) => state.worktreeVisibilityDefaultsByHost
  )
  const sshTargetLabels = useAppStore((state) => state.sshTargetLabels)
  const sshConnectionStates = useAppStore((state) => state.sshConnectionStates)
  const runtimeEnvironments = useAppStore((state) => state.runtimeEnvironments)
  const runtimeStatusByEnvironmentId = useAppStore((state) => state.runtimeStatusByEnvironmentId)
  const hideDefaultBranchWorkspace = useAppStore((state) => state.hideDefaultBranchWorkspace)
  const hideAutomationGeneratedWorkspaces = useAppStore(
    (state) => state.hideAutomationGeneratedWorkspaces
  )
  const hideCliCreatedWorkspaces = useAppStore((state) => state.hideCliCreatedWorkspaces)
  const hideDetachedHeadWorkspaces = useAppStore((state) => state.hideDetachedHeadWorkspaces)
  const hideWorkspacesFromOtherDevices = useAppStore(
    (state) => state.hideWorkspacesFromOtherDevices
  )
  const showSleepingWorkspaces = useAppStore((state) => state.showSleepingWorkspaces)
  const alwaysShowDefaultBranchWorkspace = useAppStore(
    (state) => state.alwaysShowDefaultBranchWorkspace
  )
  const lastVisitedAtByWorktreeId = useAppStore((state) => state.lastVisitedAtByWorktreeId)
  const workspacePortScan = useAppStore((state) => state.workspacePortScan?.result ?? null)
  const openNewBrowserTabInActiveWorkspace = useAppStore(
    (state) => state.openNewBrowserTabInActiveWorkspace
  )
  const openNewMarkdownInActiveWorkspace = useAppStore(
    (state) => state.openNewMarkdownInActiveWorkspace
  )
  const openNewTerminalTabInActiveWorkspace = useAppStore(
    (state) => state.openNewTerminalTabInActiveWorkspace
  )
  const settingsSections = useSettingsNavigationMetadata()

  return {
    visible,
    paletteNowMs,
    closeModal,
    openModal,
    openSettingsPage,
    openSettingsTarget,
    recordFeatureInteraction,
    revealSidebarRow,
    worktreesByRepo,
    workspaces,
    repos,
    projectGroups,
    projects,
    projectHostSetups,
    detectedWorktreesByRepo,
    pendingWorktreeCreations,
    pluginCommands,
    paletteStatusInputsActive,
    ptyIdsByTabId,
    terminalLayoutsByTabId,
    tabsByWorktree,
    prCache,
    issueCache,
    hostedReviewCache,
    migrationUnsupportedByPtyId,
    activeView,
    activeWorktreeId,
    activeWorkspaceExecutionHostId,
    activeTabType,
    activeTabId,
    activeTabIdByWorktree,
    activeFileId,
    activeFileIdByWorktree,
    activeTabTypeByWorktree,
    activeBrowserTabId,
    browserTabsByWorktree,
    browserPagesByWorkspace,
    unifiedTabsByWorktree,
    agentStatusByPaneKey,
    runtimePaneTitlesByTabId,
    unreadTerminalTabs,
    unreadAgentCompletionPanes,
    openFiles,
    activeGroupIdByWorktree,
    groupsByWorktree,
    retainedAgentsByPaneKey,
    sleepingAgentSessionsByPaneKey,
    paneForegroundAgentByPaneKey,
    settings,
    worktreeVisibilityDefaultsByHost,
    sshTargetLabels,
    sshConnectionStates,
    runtimeEnvironments,
    runtimeStatusByEnvironmentId,
    hideDefaultBranchWorkspace,
    hideAutomationGeneratedWorkspaces,
    hideCliCreatedWorkspaces,
    hideDetachedHeadWorkspaces,
    hideWorkspacesFromOtherDevices,
    showSleepingWorkspaces,
    alwaysShowDefaultBranchWorkspace,
    lastVisitedAtByWorktreeId,
    workspacePortScan,
    openNewBrowserTabInActiveWorkspace,
    openNewMarkdownInActiveWorkspace,
    openNewTerminalTabInActiveWorkspace,
    settingsSections,
    statusInputsLingering: lingering
  }
}

export type WorktreeJumpPaletteStoreState = ReturnType<typeof useWorktreeJumpPaletteStoreState>
