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
    selectedWorkspaceTarget,
    workspaceHostScope
  } = input

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
        const nextSourceRepo = getFolderSourceRepos(repos, projectGroups, nextProjectGroup)[0]
        setSelectedProjectGroupId(nextProjectGroup.id)
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
      eligibleRepos,
      actionableHostIds,
      handleRepoChange,
      isProjectGroupTarget,
      linkedWorkItem,
      projectGroups,
      projectHostSetups,
      projects,
      repos,
      setRepoId,
      selectedWorkspaceTarget,
      workspaceHostScope,
      initialProjectGroupAppliedRef,
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
      setReuseEligibleBranch,
      setReuseSelectedBranch,
      setSelectedProjectGroupId,
      setSparseDirectories,
      setSparseEnabled,
      setSparseSelectedPresetId,
      setStartFromResetHint
    ]
  )

  return {
    handleProjectChange
  }
}
