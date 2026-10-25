import { useAppStore } from '@/store'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import type { Repo } from '../../../../shared/repo-types'
import type { ComposerModel } from './composer-model'

type ProjectTargetActionsInput = Pick<
  ComposerModel,
  | 'actionableHostIds'
  | 'eligibleRepos'
  | 'handleRepoChange'
  | 'initialProjectGroupAppliedRef'
  | 'isProjectGroupTarget'
  | 'linkedWorkItem'
  | 'projectGroups'
  | 'projectHostSetups'
  | 'projects'
  | 'repos'
  | 'setBaseBranch'
  | 'setBranchNameOverride'
  | 'setBranchNameOverridePreservesNameEdits'
  | 'setForkPushWarning'
  | 'setLinkedGitLabIssue'
  | 'setLinkedGitLabMR'
  | 'setLinkedIssue'
  | 'setLinkedPR'
  | 'setLinkedTaskSourceContext'
  | 'setLinkedWorkItem'
  | 'setProjectError'
  | 'setPushTarget'
  | 'setRepoId'
  | 'setReuseEligibleBranch'
  | 'setReuseSelectedBranch'
  | 'setSelectedProjectGroupId'
  | 'setSparseDirectories'
  | 'setSparseEnabled'
  | 'setSparseSelectedPresetId'
  | 'setStartFromResetHint'
  | 'smartSourceSelectionRef'
  | 'selectedWorkspaceTarget'
  | 'workspaceHostScope'
>

import { useCallback } from 'react'
import { shouldPreserveWorkspaceSourceOnRepoChange } from '../../../../shared/new-workspace/workspace-source'
import {
  getProjectGroupIdFromNewWorkspaceOptionId,
  findActionableFolderProjectGroup
} from '@/lib/new-workspace-project-options'
import { translate } from '@/i18n/i18n'
import { getFolderSourceRepos } from '@/components/sidebar/folder-workspace-composer-helpers'
import { resolveWorkspaceCreationRepoId } from '@/lib/project-host-workspace-target'

export function useProjectTargetActions(input: ProjectTargetActionsInput) {
  const {
    actionableHostIds,
    eligibleRepos,
    handleRepoChange,
    initialProjectGroupAppliedRef,
    isProjectGroupTarget,
    linkedWorkItem,
    projectGroups,
    projectHostSetups,
    projects,
    repos,
    setBaseBranch,
    setBranchNameOverride,
    setBranchNameOverridePreservesNameEdits,
    setForkPushWarning,
    setLinkedGitLabIssue,
    setLinkedGitLabMR,
    setLinkedIssue,
    setLinkedPR,
    setLinkedTaskSourceContext,
    setLinkedWorkItem,
    setProjectError,
    setPushTarget,
    setRepoId,
    setReuseEligibleBranch,
    setReuseSelectedBranch,
    setSelectedProjectGroupId,
    setSparseDirectories,
    setSparseEnabled,
    setSparseSelectedPresetId,
    setStartFromResetHint,
    smartSourceSelectionRef,
    selectedWorkspaceTarget,
    workspaceHostScope
  } = input

  const applyProjectGroupSelection = useCallback(
    (
      group: ProjectGroup,
      sourceRepos: readonly Repo[],
      sourceGroups: readonly ProjectGroup[]
    ): void => {
      const nextSourceRepo = getFolderSourceRepos(sourceRepos, sourceGroups, group)[0]
      smartSourceSelectionRef.current = null
      setSelectedProjectGroupId(group.id)
      setProjectError(null)
      setRepoId(nextSourceRepo?.id ?? '')
      setLinkedIssue('')
      setLinkedPR(null)
      setLinkedGitLabIssue(null)
      setLinkedGitLabMR(null)
      if (linkedWorkItem && !shouldPreserveWorkspaceSourceOnRepoChange(linkedWorkItem)) {
        setLinkedWorkItem(null)
        setLinkedTaskSourceContext(null)
      }
      setSparseEnabled(false)
      setSparseDirectories('')
      setSparseSelectedPresetId(null)
      setBaseBranch(undefined)
      setPushTarget(undefined)
      setBranchNameOverride(undefined)
      // Why (#5181): clear branch-scoped reuse state on a project switch too.
      setBranchNameOverridePreservesNameEdits(false)
      setReuseEligibleBranch(null)
      setReuseSelectedBranch(false)
      setForkPushWarning(null)
      setStartFromResetHint(null)
    },
    [
      linkedWorkItem,
      setRepoId,
      setSelectedProjectGroupId,
      setProjectError,
      setLinkedIssue,
      setLinkedPR,
      setLinkedGitLabIssue,
      setLinkedGitLabMR,
      setLinkedWorkItem,
      setLinkedTaskSourceContext,
      setSparseEnabled,
      setSparseDirectories,
      setSparseSelectedPresetId,
      setBaseBranch,
      setPushTarget,
      setBranchNameOverride,
      setBranchNameOverridePreservesNameEdits,
      setReuseEligibleBranch,
      setReuseSelectedBranch,
      setForkPushWarning,
      setStartFromResetHint,
      smartSourceSelectionRef
    ]
  )

  const selectAddedProjectGroup = useCallback(
    (groupId: string): boolean => {
      const state = useAppStore.getState()
      const group = findActionableFolderProjectGroup({
        projectGroups: state.projectGroups,
        groupId,
        actionableHostIds
      })
      if (!group) {
        return false
      }
      initialProjectGroupAppliedRef.current = true
      applyProjectGroupSelection(group, state.repos, state.projectGroups)
      return true
    },
    [actionableHostIds, initialProjectGroupAppliedRef, applyProjectGroupSelection]
  )

  const handleProjectChange = useCallback(
    (projectId: string): void => {
      initialProjectGroupAppliedRef.current = true
      const projectGroupId = getProjectGroupIdFromNewWorkspaceOptionId(projectId)
      if (projectGroupId) {
        const nextProjectGroup = findActionableFolderProjectGroup({
          projectGroups,
          groupId: projectGroupId,
          actionableHostIds
        })
        if (!nextProjectGroup) {
          setSelectedProjectGroupId(null)
          setProjectError(
            translate(
              'auto.hooks.useComposerState.chooseOrAddProjectBeforeWorkspace',
              'Choose or add a project before creating a workspace.'
            )
          )
          return
        }
        applyProjectGroupSelection(nextProjectGroup, repos, projectGroups)
        return
      }

      setSelectedProjectGroupId(null)
      const preferredHostId =
        selectedWorkspaceTarget.status === 'ready' ? selectedWorkspaceTarget.target.hostId : null
      // Why: pass the current host as a preference (focusedHostScope), not a hard hostId — pinning made selecting a project set up only on another host a silent no-op.
      const nextRepoId = resolveWorkspaceCreationRepoId({
        eligibleRepos,
        projects,
        projectHostSetups,
        projectId,
        focusedHostScope: preferredHostId ?? workspaceHostScope,
        actionableHostIds
      })
      if (!nextRepoId) {
        return
      }
      handleRepoChange(nextRepoId, { forceResetStartFrom: isProjectGroupTarget })
    },
    [
      applyProjectGroupSelection,
      eligibleRepos,
      actionableHostIds,
      handleRepoChange,
      isProjectGroupTarget,
      projectGroups,
      projectHostSetups,
      projects,
      repos,
      selectedWorkspaceTarget,
      workspaceHostScope,
      initialProjectGroupAppliedRef,
      setSelectedProjectGroupId,
      setProjectError
    ]
  )

  return {
    handleProjectChange,
    selectAddedProjectGroup
  }
}
