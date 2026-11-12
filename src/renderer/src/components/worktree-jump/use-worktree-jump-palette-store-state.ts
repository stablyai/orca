import { useMemo, useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store/index'
import { usePluginCommands } from '@/store/plugins/catalog/plugin-contribution-catalog'
import { usePluginNewFiles } from '@/store/plugins/file-creation/plugin-new-files'
import { useSettingsNavigationMetadata } from '@/hooks/useSettingsNavigationMetadata'
import { dedupePaletteWorktrees } from '@/lib/workspace/search/palette-repo-resolution'
import {
  readHiddenVmCheckouts,
  subscribeHiddenVmCheckouts,
  withoutHiddenVmWorktreesByRepo,
  withoutHiddenVmWorktrees
} from '@/runtime/ephemeral-vm/vm-create-hidden-checkouts'
import {
  selectPaletteIndexStatusSnapshot,
  selectPaletteStatusInputs
} from './worktree-jump-palette-status-inputs'
import { selectWorktreePaletteCacheInputs } from '@/components/cmd-j/worktree-palette-cache-inputs'
import { resolveQualifiedIndexedFolderWorkspace } from '@/store/folder-workspaces/folder-workspace-record-index'
import {
  selectFolderWorkspaces,
  selectWorktreesByRepo
} from '@/store/workspaces/catalog/workspace-record-fields'
import { getFolderWorkspaceWorktree } from '../../../../shared/folder-workspaces/folder-workspace-worktree'
import { createExistingContentWorktreeSelector } from '@/lib/workspace/tabs/existing-content-worktree-selector'
import {
  createPaletteImportedProjectSelector,
  EMPTY_IMPORTED_PROJECT_REPO_IDS
} from './worktree-jump-imported-projects'
import { EMPTY_SORTED_WORKTREES } from './worktree-jump-palette-model'

export function useWorktreeJumpPaletteStoreState({
  visible,
  lingering
}: {
  visible: boolean
  lingering: boolean
}) {
  useTranslation()
  const paletteStatusInputsActive = visible || lingering
  // Freeze age labels for one palette session; live status dots own their clock separately.
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- visibility intentionally starts a new session clock.
  const paletteNowMs = useMemo(() => Date.now(), [visible])
  const closeModal = useAppStore((state) => state.closeModal)
  const openModal = useAppStore((state) => state.openModal)
  const openSettingsPage = useAppStore((state) => state.openSettingsPage)
  const openSettingsTarget = useAppStore((state) => state.openSettingsTarget)
  const recordFeatureInteraction = useAppStore((state) => state.recordFeatureInteraction)
  const revealSidebarRow = useAppStore((state) => state.revealSidebarRow)
  const storedWorktreesByRepo = useAppStore((state) => selectWorktreesByRepo(state))
  const hiddenVmCheckouts = useSyncExternalStore(subscribeHiddenVmCheckouts, readHiddenVmCheckouts)
  // Why: a VM create's checkout is not a workspace until the create adopts it.
  const worktreesByRepo = useMemo(
    () => withoutHiddenVmWorktreesByRepo(storedWorktreesByRepo, hiddenVmCheckouts),
    [storedWorktreesByRepo, hiddenVmCheckouts]
  )
  const folderWorkspaces = useAppStore((state) => selectFolderWorkspaces(state))
  const repos = useAppStore((state) => state.repos)
  const projectGroups = useAppStore((state) => state.projectGroups)
  const workspaces = useMemo(
    () =>
      dedupePaletteWorktrees([
        ...Object.values(worktreesByRepo).flat(),
        ...folderWorkspaces.map((folder) => {
          const result = resolveQualifiedIndexedFolderWorkspace(
            { folderWorkspaces, repos, projectGroups },
            folder.id
          )
          return getFolderWorkspaceWorktree(
            folder,
            result.kind === 'selected' && result.value.workspace === folder
              ? result.value
              : undefined
          )
        })
      ]),
    [folderWorkspaces, projectGroups, repos, worktreesByRepo]
  )
  const projects = useAppStore((state) => state.projects)
  const projectHostSetups = useAppStore((state) => state.projectHostSetups)
  const [selectContentWorktrees] = useState(createExistingContentWorktreeSelector)
  const contentRows = useAppStore((state) =>
    paletteStatusInputsActive ? selectContentWorktrees(state) : EMPTY_SORTED_WORKTREES
  )
  const contentWorkspaces = useMemo(
    () => withoutHiddenVmWorktrees(contentRows, hiddenVmCheckouts),
    [contentRows, hiddenVmCheckouts]
  )
  const [selectImportedProjects] = useState(createPaletteImportedProjectSelector)
  const importedProjectRepoIds = useAppStore((state) =>
    paletteStatusInputsActive ? selectImportedProjects(state) : EMPTY_IMPORTED_PROJECT_REPO_IDS
  )
  const pendingWorktreeCreations = useAppStore((state) => state.pendingWorktreeCreations)
  const pluginCommands = usePluginCommands()
  const pluginNewFiles = usePluginNewFiles()
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
  const structuredChatSleptAtByPaneKey = useAppStore(
    (state) => state.structuredChatSleptAtByPaneKey
  )
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
    pendingVmRepoIds: hiddenVmCheckouts.repoIds,
    workspaces,
    contentWorkspaces,
    repos,
    projectGroups,
    projects,
    projectHostSetups,
    importedProjectRepoIds,
    pendingWorktreeCreations,
    pluginCommands,
    pluginNewFiles,
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
    structuredChatSleptAtByPaneKey,
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
