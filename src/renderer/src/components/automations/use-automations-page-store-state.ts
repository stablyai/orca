import { useCallback } from 'react'
import { filterEnabledTuiAgents, isTuiAgentEnabled } from '../../../../shared/tui-agent-selection'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { getAgentCatalog } from '@/lib/agent-catalog'
import { useAppStore } from '@/store'
import { useRepoMap, useWorktreeMap } from '@/store/selectors'
import {
  automationFolderWorktreeForRow,
  automationRepoForRow,
  automationWorktreeForRow,
  type AutomationListRow
} from './automation-list-row-identity'
import { selectFolderWorkspaces, selectWorktreesByRepo } from '@/store/workspace-record-selectors'

const AGENTS = getAgentCatalog().map((agent) => agent.id)

/** Store-backed values shared by the page's state and action hooks. */
export function useAutomationsPageStoreState() {
  const repos = useAppStore((s) => s.repos)
  const projectGroups = useAppStore((s) => s.projectGroups)
  const projectHostSetups = useAppStore((s) => s.projectHostSetups)
  const worktreesByRepo = useAppStore((s) => selectWorktreesByRepo(s))
  const folderWorkspaces = useAppStore((s) => selectFolderWorkspaces(s))
  const unifiedTabsByWorktree = useAppStore((s) => s.unifiedTabsByWorktree)
  const terminalLayoutsByTabId = useAppStore((s) => s.terminalLayoutsByTabId)
  const ptyIdsByTabId = useAppStore((s) => s.ptyIdsByTabId)
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const fetchWorktrees = useAppStore((s) => s.fetchWorktrees)
  const fetchRuntimeEnvironmentRepos = useAppStore((s) => s.fetchRuntimeEnvironmentRepos)
  const fetchAllWorktrees = useAppStore((s) => s.fetchAllWorktrees)
  const startupWorktreeRefreshCompleted = useAppStore((s) => s.startupWorktreeRefreshCompleted)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const openSettingsPage = useAppStore((s) => s.openSettingsPage)
  const openSettingsTarget = useAppStore((s) => s.openSettingsTarget)
  const closeAutomationsPage = useAppStore((s) => s.closeAutomationsPage)
  const activeModal = useAppStore((s) => s.activeModal)
  const sshConnectionStates = useAppStore((s) => s.sshConnectionStates)
  const sshStateByEnvironment = useAppStore((s) => s.sshStateByEnvironment)
  const sshTargetLabels = useAppStore((s) => s.sshTargetLabels)
  const runtimeEnvironments = useAppStore((s) => s.runtimeEnvironments)
  const runtimeStatusByEnvironmentId = useAppStore((s) => s.runtimeStatusByEnvironmentId)
  const settings = useAppStore((s) => s.settings)
  const selectedId = useAppStore((s) => s.selectedAutomationId)
  const setSelectedId = useAppStore((s) => s.setSelectedAutomationId)
  const pendingAutomationRunNavigation = useAppStore((s) => s.pendingAutomationRunNavigation)
  const setPendingAutomationRunNavigation = useAppStore((s) => s.setPendingAutomationRunNavigation)
  const repoMap = useRepoMap()
  const worktreeMap = useWorktreeMap()
  const repoForRow = useCallback(
    (row: AutomationListRow): Repo | undefined => automationRepoForRow(row, repos),
    [repos]
  )
  const worktreeForRow = useCallback(
    (
      row: AutomationListRow,
      repo: Repo | undefined,
      workspaceId: string | null | undefined = row.automation.workspaceId
    ): Worktree | undefined =>
      automationFolderWorktreeForRow(row, folderWorkspaces, workspaceId, {
        repos,
        projectGroups
      }) ?? automationWorktreeForRow(row, worktreesByRepo, repo, repos, workspaceId),
    [folderWorkspaces, projectGroups, repos, worktreesByRepo]
  )
  const enabledAgents = filterEnabledTuiAgents(AGENTS, settings?.disabledTuiAgents)
  const defaultAgent =
    settings?.defaultTuiAgent &&
    settings.defaultTuiAgent !== 'blank' &&
    isTuiAgentEnabled(settings.defaultTuiAgent, settings.disabledTuiAgents)
      ? settings.defaultTuiAgent
      : (enabledAgents[0] ?? AGENTS[0])

  return {
    repos,
    projectGroups,
    projectHostSetups,
    worktreesByRepo,
    unifiedTabsByWorktree,
    terminalLayoutsByTabId,
    ptyIdsByTabId,
    activeWorktreeId,
    fetchWorktrees,
    fetchRuntimeEnvironmentRepos,
    fetchAllWorktrees,
    startupWorktreeRefreshCompleted,
    updateSettings,
    openSettingsPage,
    openSettingsTarget,
    closeAutomationsPage,
    activeModal,
    sshConnectionStates,
    sshStateByEnvironment,
    sshTargetLabels,
    runtimeEnvironments,
    runtimeStatusByEnvironmentId,
    settings,
    selectedId,
    setSelectedId,
    pendingAutomationRunNavigation,
    setPendingAutomationRunNavigation,
    repoMap,
    worktreeMap,
    repoForRow,
    worktreeForRow,
    defaultAgent
  }
}

export type AutomationsPageStoreState = ReturnType<typeof useAutomationsPageStoreState>
