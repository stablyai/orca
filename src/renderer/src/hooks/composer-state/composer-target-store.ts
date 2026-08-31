import { useMemo } from 'react'
import { useAppStore } from '@/store'
import { useShallow } from 'zustand/react/shallow'
import {
  getComposerEligibleRepos,
  resolveComposerActiveRepoId
} from '@/lib/new-workspace-composer-repo'
import { buildExecutionHostRegistry } from '../../../../shared/execution-host-registry'
import { getHostDisplayLabelOverrides } from '../../../../shared/host-setting-overrides'
import type { GitHubWorkItem } from '../../../../shared/github/work-item-types'
import type { TaskSourceContext } from '../../../../shared/task-source-context'
import type { WorkspaceStatus } from '../../../../shared/worktree/types'
import type { WorkspaceSource as WorkspaceCreateTelemetrySource } from '../../../../shared/workspace-source'
import type { LinkedWorkItemSummary } from '@/lib/new-workspace'
import type { ComposerDecisions } from './composer-decisions'

export type ComposerStateInput = {
  initialRepoId?: string
  initialEphemeralVmRecipeId?: string
  initialProjectGroupId?: string
  initialName?: string
  initialPrompt?: string
  initialLinkedWorkItem?: LinkedWorkItemSummary | null
  initialGitHubWorkItem?: GitHubWorkItem | null
  initialTaskSourceContext?: TaskSourceContext | null
  initialWorkspaceStatus?: WorkspaceStatus
  initialBaseBranch?: string
  persistDraft: boolean
  onCreated?: () => void
  isSubmissionCancelled?: () => boolean
  repoIdOverride?: string
  onRepoIdOverrideChange?: (value: string) => void
  telemetrySource?: WorkspaceCreateTelemetrySource
  enableIssueAutomation?: boolean
  createGateMode?: 'full' | 'quick'
}

const NEVER_CANCEL_COMPOSER_SUBMIT = (): boolean => false

export function useComposerTargetStore(options: ComposerStateInput, decisions: ComposerDecisions) {
  const {
    initialRepoId,
    initialEphemeralVmRecipeId,
    initialName = '',
    initialPrompt = '',
    initialLinkedWorkItem = null,
    initialGitHubWorkItem = null,
    initialTaskSourceContext = null,
    initialWorkspaceStatus,
    initialBaseBranch,
    persistDraft,
    onCreated,
    isSubmissionCancelled = NEVER_CANCEL_COMPOSER_SUBMIT,
    repoIdOverride,
    onRepoIdOverrideChange,
    telemetrySource,
    enableIssueAutomation = true,
    createGateMode = 'full',
    initialProjectGroupId
  } = options

  const actions = useAppStore(
    useShallow((s) => ({
      setNewWorkspaceDraft: s.setNewWorkspaceDraft,
      clearNewWorkspaceDraft: s.clearNewWorkspaceDraft,
      createWorktree: s.createWorktree,
      updateRepo: s.updateRepo,
      updateWorktreeMeta: s.updateWorktreeMeta,
      createFolderWorkspace: s.createFolderWorkspace,
      setSidebarOpen: s.setSidebarOpen,
      closeModal: s.closeModal,
      openSettingsPage: s.openSettingsPage,
      openSettingsTarget: s.openSettingsTarget,
      setActiveRuntimeEnvironmentPreference: s.setActiveRuntimeEnvironmentPreference,
      prefetchWorktreeCreateBase: s.prefetchWorktreeCreateBase,
      prefetchWorkItems: s.prefetchWorkItems,
      fetchSparsePresets: s.fetchSparsePresets
    }))
  )

  const {
    setNewWorkspaceDraft,
    clearNewWorkspaceDraft,
    createWorktree,
    updateRepo,
    updateWorktreeMeta,
    createFolderWorkspace,
    setSidebarOpen,
    closeModal,
    openSettingsPage,
    openSettingsTarget,
    setActiveRuntimeEnvironmentPreference,
    prefetchWorktreeCreateBase,
    prefetchWorkItems,
    fetchSparsePresets
  } = actions

  const repos = useAppStore((s) => s.repos)

  const projects = useAppStore((s) => s.projects)

  const projectGroups = useAppStore((s) => s.projectGroups)

  const projectHostSetups = useAppStore((s) => s.projectHostSetups)

  const activeRepoId = useAppStore((s) => s.activeRepoId)

  const settings = useAppStore((s) => s.settings)

  const newWorkspaceDraft = useAppStore((s) => s.newWorkspaceDraft)

  const worktreesByRepo = useAppStore((s) => s.worktreesByRepo)

  const sparsePresetsByRepo = useAppStore((s) => s.sparsePresetsByRepo)

  const workspaceStatuses = useAppStore((s) => s.workspaceStatuses)

  const sshConnectionStates = useAppStore((s) => s.sshConnectionStates)

  const sshTargetLabels = useAppStore((s) => s.sshTargetLabels)

  const sshConnectedGeneration = useAppStore((s) => s.sshConnectedGeneration)

  const runtimeEnvironments = useAppStore((s) => s.runtimeEnvironments)

  const runtimeStatusByEnvironmentId = useAppStore((s) => s.runtimeStatusByEnvironmentId)

  const workspaceHostScope = useAppStore((s) => s.workspaceHostScope)

  const eligibleRepos = useMemo(() => getComposerEligibleRepos(repos), [repos])

  const hostOptions = useMemo(
    () =>
      buildExecutionHostRegistry({
        repos,
        settings,
        hostSource: 'configured-only',
        sshTargetLabels,
        sshConnectionStates,
        runtimeEnvironments,
        runtimeStatusByEnvironmentId,
        hostLabelOverrides: getHostDisplayLabelOverrides(settings)
      }),
    [
      repos,
      settings,
      sshConnectionStates,
      sshTargetLabels,
      runtimeEnvironments,
      runtimeStatusByEnvironmentId
    ]
  )

  const actionableHostIds = useMemo(
    () => new Set(hostOptions.map((host) => host.id)),
    [hostOptions]
  )

  const seedActiveRepoId = useMemo(
    () => resolveComposerActiveRepoId(repos, eligibleRepos, activeRepoId),
    [repos, eligibleRepos, activeRepoId]
  )

  return {
    initialRepoId,
    initialEphemeralVmRecipeId,
    initialName,
    initialPrompt,
    initialLinkedWorkItem,
    initialGitHubWorkItem,
    initialTaskSourceContext,
    initialWorkspaceStatus,
    initialBaseBranch,
    persistDraft,
    onCreated,
    isSubmissionCancelled,
    repoIdOverride,
    onRepoIdOverrideChange,
    telemetrySource,
    enableIssueAutomation,
    createGateMode,
    initialProjectGroupId,
    decisions,
    actions,
    setNewWorkspaceDraft,
    clearNewWorkspaceDraft,
    createWorktree,
    updateRepo,
    updateWorktreeMeta,
    createFolderWorkspace,
    setSidebarOpen,
    closeModal,
    openSettingsPage,
    openSettingsTarget,
    setActiveRuntimeEnvironmentPreference,
    prefetchWorktreeCreateBase,
    prefetchWorkItems,
    fetchSparsePresets,
    repos,
    projects,
    projectGroups,
    projectHostSetups,
    activeRepoId,
    settings,
    newWorkspaceDraft,
    worktreesByRepo,
    sparsePresetsByRepo,
    workspaceStatuses,
    sshConnectionStates,
    sshTargetLabels,
    sshConnectedGeneration,
    runtimeEnvironments,
    runtimeStatusByEnvironmentId,
    workspaceHostScope,
    eligibleRepos,
    hostOptions,
    actionableHostIds,
    seedActiveRepoId
  }
}
