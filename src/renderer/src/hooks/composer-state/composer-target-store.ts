import {
  selectCanonicalProjects,
  selectCanonicalProjectHostSetups
} from '@/store/project-host-setup-selector'
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
import type { WorkspaceCreationTargetHint } from '@/lib/project-host-workspace-target'
import { selectWorktreesByRepo } from '@/store/workspace-record-selectors'
import { selectAllKnownWorkspaceStatuses } from '@/store/host-workspace-status-columns'

export type ComposerStateInput = {
  initialRepoId?: string
  initialParentWorktreeId?: string | null
  initialEphemeralVmRecipeId?: string
  initialProjectGroupId?: string
  initialName?: string
  initialPrompt?: string
  initialLinkedWorkItem?: LinkedWorkItemSummary | null
  initialGitHubWorkItem?: GitHubWorkItem | null
  initialTaskSourceContext?: TaskSourceContext | null
  initialWorkspaceTarget?: WorkspaceCreationTargetHint | null
  initialWorkspaceStatus?: WorkspaceStatus
  initialBaseBranch?: string
  persistDraft: boolean
  onCreated?: () => void
  isSubmissionCancelled?: () => boolean
  repoIdOverride?: string
  onRepoIdOverrideChange?: (value: string) => void
  telemetrySource?: WorkspaceCreateTelemetrySource
  enableIssueAutomation?: boolean
}

const NEVER_CANCEL_COMPOSER_SUBMIT = (): boolean => false

export function useComposerTargetStore(options: ComposerStateInput, decisions: ComposerDecisions) {
  const {
    initialRepoId,
    initialParentWorktreeId,
    initialEphemeralVmRecipeId,
    initialName = '',
    initialPrompt = '',
    initialLinkedWorkItem = null,
    initialGitHubWorkItem = null,
    initialTaskSourceContext = null,
    initialWorkspaceTarget = null,
    initialWorkspaceStatus,
    initialBaseBranch,
    persistDraft,
    onCreated,
    isSubmissionCancelled = NEVER_CANCEL_COMPOSER_SUBMIT,
    repoIdOverride,
    onRepoIdOverrideChange,
    telemetrySource,
    enableIssueAutomation = true,
    initialProjectGroupId
  } = options

  const actions = useAppStore(
    useShallow((s) => ({
      setNewWorkspaceDraft: s.setNewWorkspaceDraft,
      clearNewWorkspaceDraft: s.clearNewWorkspaceDraft,
      updateRepo: s.updateRepo,
      createFolderWorkspace: s.createFolderWorkspace,
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
    updateRepo,
    createFolderWorkspace,
    closeModal,
    openSettingsPage,
    openSettingsTarget,
    setActiveRuntimeEnvironmentPreference,
    prefetchWorktreeCreateBase,
    prefetchWorkItems,
    fetchSparsePresets
  } = actions

  const repos = useAppStore((s) => s.repos)

  const projects = useAppStore((s) => selectCanonicalProjects(s))

  const projectGroups = useAppStore((s) => s.projectGroups)

  const projectHostSetups = useAppStore((s) => selectCanonicalProjectHostSetups(s))

  const activeRepoId = useAppStore((s) => s.activeRepoId)

  const settings = useAppStore((s) => s.settings)

  const newWorkspaceDraft = useAppStore((s) => s.newWorkspaceDraft)

  const worktreesByRepo = useAppStore((s) => selectWorktreesByRepo(s))

  const sparsePresetsByRepo = useAppStore((s) => s.sparsePresetsByRepo)

  // Every paired host's columns too, so a host-only lane's + keeps its status; submit scopes it to the target.
  const workspaceStatuses = useAppStore(useShallow(selectAllKnownWorkspaceStatuses))

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
    initialParentWorktreeId,
    initialEphemeralVmRecipeId,
    initialName,
    initialPrompt,
    initialLinkedWorkItem,
    initialGitHubWorkItem,
    initialTaskSourceContext,
    initialWorkspaceTarget,
    initialWorkspaceStatus,
    initialBaseBranch,
    persistDraft,
    onCreated,
    isSubmissionCancelled,
    repoIdOverride,
    onRepoIdOverrideChange,
    telemetrySource,
    enableIssueAutomation,
    initialProjectGroupId,
    decisions,
    actions,
    setNewWorkspaceDraft,
    clearNewWorkspaceDraft,
    updateRepo,
    createFolderWorkspace,
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
