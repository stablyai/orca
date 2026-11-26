import { useMemo, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import { useRuntimeStatusByEnvironmentId } from '@/store/slices/runtime-status/views/use-runtime-status-view'
import { useAppStore } from '@/store/index'
import type { AppState } from '@/store/types'
import { usePluginCommands } from '@/store/plugins/catalog/plugin-contribution-catalog'
import { usePluginNewFiles } from '@/store/plugins/file-creation/plugin-new-files'
import { useSettingsNavigationMetadata } from '@/components/settings/navigation/useSettingsNavigationMetadata'
import { dedupePaletteWorktrees } from '@/lib/workspace/search/palette-repo-resolution'
import {
  readHiddenVmCheckouts,
  subscribeHiddenVmCheckouts,
  withoutHiddenVmWorktreesByRepo
} from '@/runtime/ephemeral-vm/vm-create-hidden-checkouts'
import {
  selectPaletteIndexStatusSnapshot,
  selectPaletteStatusInputs
} from './worktree-jump-palette-status-inputs'
import { selectWorktreePaletteCacheInputs } from '@/components/cmd-j/worktree-palette-cache-inputs'
import { resolveQualifiedIndexedFolderWorkspace } from '@/store/folder-workspaces/folder-workspace-record-index'
import {
  selectDetectedWorktreesByRepo,
  selectFolderWorkspaces,
  selectWorktreesByRepo
} from '@/store/workspaces/catalog/workspace-record-fields'
import { getFolderWorkspaceWorktree } from '../../../../../shared/folder-workspaces/folder-workspace-worktree'
import type { Worktree } from '../../../../../shared/worktree/types'

const NO_WORKTREES_BY_REPO: AppState['worktreesByRepo'] = {}
const NO_WORKSPACES: Worktree[] = []
const NO_UNIFIED_TABS: AppState['unifiedTabsByWorktree'] = {}
const NO_BROWSER_PAGES: AppState['browserPagesByWorkspace'] = {}
const NO_OPEN_FILES: AppState['openFiles'] = []

export function useWorktreeJumpPaletteStoreState({
  visible,
  lingering,
  resultsReady
}: {
  visible: boolean
  lingering: boolean
  /** False for the opening frame: result sources stay empty so the input paints first. */
  resultsReady: boolean
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
  const storedWorktreesByRepo = useAppStore((state) => selectWorktreesByRepo(state))
  const hiddenVmCheckouts = useSyncExternalStore(subscribeHiddenVmCheckouts, readHiddenVmCheckouts)
  // Why: a VM create's checkout is not a workspace until the create adopts it.
  const worktreesByRepo = useMemo(
    () =>
      resultsReady
        ? withoutHiddenVmWorktreesByRepo(storedWorktreesByRepo, hiddenVmCheckouts)
        : NO_WORKTREES_BY_REPO,
    [storedWorktreesByRepo, hiddenVmCheckouts, resultsReady]
  )
  const folderWorkspaces = useAppStore((state) => selectFolderWorkspaces(state))
  const repos = useAppStore((state) => state.repos)
  const projectGroups = useAppStore((state) => state.projectGroups)
  const workspaces = useMemo(
    () =>
      resultsReady
        ? dedupePaletteWorktrees([
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
          ])
        : NO_WORKSPACES,
    [folderWorkspaces, projectGroups, repos, worktreesByRepo, resultsReady]
  )
  const projects = useAppStore((state) => state.projects)
  const projectHostSetups = useAppStore((state) => state.projectHostSetups)
  const detectedWorktreesByRepo = useAppStore((state) => selectDetectedWorktreesByRepo(state))
  const pendingWorktreeCreations = useAppStore((state) => state.pendingWorktreeCreations)
  const pluginCommands = usePluginCommands()
  const pluginNewFiles = usePluginNewFiles()
  const paletteStatusInputsActive = (visible || lingering) && resultsReady
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
  const browserPagesByWorkspace = useAppStore((state) =>
    resultsReady ? state.browserPagesByWorkspace : NO_BROWSER_PAGES
  )
  const unifiedTabsByWorktree = useAppStore((state) =>
    resultsReady ? state.unifiedTabsByWorktree : NO_UNIFIED_TABS
  )
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
  const openFiles = useAppStore((state) => (resultsReady ? state.openFiles : NO_OPEN_FILES))
  const activeGroupIdByWorktree = useAppStore((state) => state.activeGroupIdByWorktree)
  const groupsByWorktree = useAppStore((state) => state.groupsByWorktree)
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
  const runtimeStatusByEnvironmentId = useRuntimeStatusByEnvironmentId()
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
  const settingsSections = useSettingsNavigationMetadata(undefined, resultsReady)

  return {
    visible,
    resultsReady,
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
    repos,
    projectGroups,
    projects,
    projectHostSetups,
    detectedWorktreesByRepo,
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
