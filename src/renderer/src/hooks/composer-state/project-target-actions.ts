import type { ComposerModel } from './composer-model'

type ProjectTargetActionsInput = Pick<
  ComposerModel,
  | 'actionableHostIds'
  | 'eligibleRepos'
  | 'handleRepoChange'
  | 'hostOptions'
  | 'setPendingInitialWorkspaceTarget'
  | 'setSelectedProjectHostSetupOverrideId'
  | 'setSelectedProjectHostSetupOverrideHostId'
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
import { resolveWorkspaceCreationTarget } from '@/lib/project-host-workspace-target'

export function useProjectTargetActions(input: ProjectTargetActionsInput) {
  const {
    actionableHostIds,
    eligibleRepos,
    handleRepoChange,
    hostOptions,
    setPendingInitialWorkspaceTarget,
    setSelectedProjectHostSetupOverrideId,
    setSelectedProjectHostSetupOverrideHostId,
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
        smartSourceSelectionRef.current = null
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
      // Prefer the current host while allowing projects set up only on another host.
      const resolution = resolveWorkspaceCreationTarget({
        eligibleRepos,
        projects,
        projectHostSetups,
        hosts: hostOptions,
        projectId,
        focusedHostScope: preferredHostId ?? workspaceHostScope,
        actionableHostIds
      })
      if (resolution.status === 'ambiguous') {
        handleRepoChange('', { forceResetStartFrom: true })
        const firstHostId = resolution.candidates[0]?.hostId ?? null
        const hostId = resolution.candidates.every((candidate) => candidate.hostId === firstHostId)
          ? firstHostId
          : null
        setPendingInitialWorkspaceTarget({ projectId, hostId, projectHostSetupId: null })
        return
      }
      if (resolution.status !== 'ready') {
        return
      }
      handleRepoChange(resolution.target.repoId, { forceResetStartFrom: isProjectGroupTarget })
      setSelectedProjectHostSetupOverrideId(resolution.target.projectHostSetupId)
      setSelectedProjectHostSetupOverrideHostId(resolution.target.hostId)
    },
    [
      eligibleRepos,
      actionableHostIds,
      handleRepoChange,
      hostOptions,
      setPendingInitialWorkspaceTarget,
      setSelectedProjectHostSetupOverrideId,
      setSelectedProjectHostSetupOverrideHostId,
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
      setStartFromResetHint,
      smartSourceSelectionRef
    ]
  )

  return {
    handleProjectChange
  }
}
