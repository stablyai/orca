import { useMemo } from 'react'
import { useAppStore } from '@/store'
import { getProjectGroupingIndexFromState } from '@/store/project-host-setup-selector'
import { getProjectGroupForRepo } from '../../../../shared/project-section-grouping'
import { buildProjectHostSetupOptions } from '@/lib/project-host-setup-options'
import { buildNewWorkspaceCreateTargetOptions } from '@/lib/new-workspace-project-options'
import type { WorkspaceCreationTargetResolution } from '@/lib/project-host-workspace-target'
import type { Repo } from '../../../../shared/repo-types'
import type { ComposerRuntimeTargetSelectionInput } from './composer-target-input-contracts'

export function useComposerProjectOptions(
  input: Pick<
    ComposerRuntimeTargetSelectionInput,
    | 'eligibleRepos'
    | 'hostOptions'
    | 'projectHostSetups'
    | 'projects'
    | 'settings'
    | 'projectGroups'
    | 'selectedProjectGroup'
  >,
  selectedWorkspaceTarget: WorkspaceCreationTargetResolution,
  selectedRepo: Repo | undefined
) {
  const {
    eligibleRepos,
    hostOptions,
    projectHostSetups,
    projects,
    settings,
    projectGroups,
    selectedProjectGroup
  } = input
  const selectedRepoProjectId =
    selectedWorkspaceTarget.status === 'ready' ? selectedWorkspaceTarget.target.projectId : null

  const grouping = useAppStore(getProjectGroupingIndexFromState)
  const selectedProjectId = selectedProjectGroup
    ? `project-group:${selectedProjectGroup.id}`
    : selectedRepo
      ? (getProjectGroupForRepo(grouping, selectedRepo)?.key ?? selectedRepoProjectId)
      : selectedRepoProjectId

  const selectedProjectHostSetupId =
    !selectedProjectGroup && selectedWorkspaceTarget.status === 'ready'
      ? selectedWorkspaceTarget.target.projectHostSetupId
      : null

  const projectHostSetupOptions = useMemo(
    () =>
      buildProjectHostSetupOptions({
        projectId: selectedRepoProjectId,
        groupKey: selectedProjectId,
        settings,
        grouping,
        projectHostSetups,
        eligibleRepos,
        hosts: hostOptions
      }),
    [
      eligibleRepos,
      hostOptions,
      projectHostSetups,
      selectedRepoProjectId,
      selectedProjectId,
      settings,
      grouping
    ]
  )

  const projectOptions = useMemo(
    () =>
      buildNewWorkspaceCreateTargetOptions({
        projects,
        projectHostSetups,
        eligibleRepos,
        projectGroups,
        hosts: hostOptions,
        settings,
        grouping
      }),
    [eligibleRepos, hostOptions, projectGroups, projectHostSetups, projects, settings, grouping]
  )

  return {
    selectedRepoProjectId,
    selectedProjectId,
    selectedProjectHostSetupId,
    projectHostSetupOptions,
    projectOptions
  }
}
