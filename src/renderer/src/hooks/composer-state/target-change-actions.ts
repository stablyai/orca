import { selectCanonicalProjectHostSetups } from '@/store/project-host-setup-selector'
import type { ComposerModel } from './composer-model'

type TargetChangeActionsInput = Pick<
  ComposerModel,
  | 'baseBranch'
  | 'branchAutoNameRef'
  | 'decisions'
  | 'folderSourceRepos'
  | 'hostOptions'
  | 'linkedWorkItem'
  | 'projectHostSetupOptions'
  | 'repoId'
  | 'selectedRepoProjectId'
  | 'setBaseBranch'
  | 'setBranchNameOverride'
  | 'setBranchNameOverridePreservesNameEdits'
  | 'setCompareBaseRef'
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
  | 'setSelectedProjectHostSetupOverrideId'
  | 'setSelectedProjectHostSetupOverrideHostId'
  | 'setSparseDirectories'
  | 'setSparseEnabled'
  | 'setSparseSelectedPresetId'
  | 'setStartFromResetHint'
  | 'smartSourceSelectionRef'
>

import { useCallback } from 'react'
import {
  isLinearLinkedWorkItem,
  getLinearLinkedWorkItemBranchName
} from '@/lib/linear-linked-work-item'
import { shouldPreserveWorkspaceSourceOnRepoChange } from '../../../../shared/new-workspace/workspace-source'
import {
  buildProjectHostSetupOptions,
  getProjectHostSetupSelectionKey,
  type ProjectHostSetupOption,
  type ReadyProjectHostSetupOption
} from '@/lib/project-host-setup-options'
import { useAppStore } from '@/store'
import { getComposerEligibleRepos } from '@/lib/new-workspace-composer-repo'

export function useTargetChangeActions(input: TargetChangeActionsInput) {
  const {
    baseBranch,
    branchAutoNameRef,
    decisions,
    folderSourceRepos,
    hostOptions,
    linkedWorkItem,
    projectHostSetupOptions,
    repoId,
    selectedRepoProjectId,
    setBaseBranch,
    setBranchNameOverride,
    setBranchNameOverridePreservesNameEdits,
    setCompareBaseRef,
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
    setSelectedProjectHostSetupOverrideId,
    setSelectedProjectHostSetupOverrideHostId,
    setSparseDirectories,
    setSparseEnabled,
    setSparseSelectedPresetId,
    setStartFromResetHint,
    smartSourceSelectionRef
  } = input
  const { retargetGitHubPrStartPointSelection } = decisions

  const handleRepoChange = useCallback(
    (
      value: string,
      options: { preserveStartFrom?: boolean; forceResetStartFrom?: boolean } = {}
    ): void => {
      setProjectError(null)
      if (value === repoId && !options.forceResetStartFrom) {
        if (!options.preserveStartFrom) {
          setSelectedProjectHostSetupOverrideId(null)
          setSelectedProjectHostSetupOverrideHostId(null)
        }
        setRepoId(value)
        return
      }
      // Retain the previous checkout-source label so repo switches can show what reset.
      let hint: string | null = null
      if (!options.preserveStartFrom) {
        if (linkedWorkItem?.type === 'pr' && baseBranch) {
          hint = `was PR #${linkedWorkItem.number}`
        } else if (linkedWorkItem?.type === 'mr' && baseBranch) {
          // Use GitLab’s !N convention in the reset hint.
          hint = `was MR !${linkedWorkItem.number}`
        } else if (baseBranch) {
          hint = `was ${baseBranch}`
        }
      }
      const preserveLinearLinkedWorkItem = isLinearLinkedWorkItem(linkedWorkItem)
      const preservedLinearBranchName = preserveLinearLinkedWorkItem
        ? getLinearLinkedWorkItemBranchName(linkedWorkItem)
        : undefined
      setRepoId(value)
      if (!options.preserveStartFrom) {
        setSelectedProjectHostSetupOverrideId(null)
        setSelectedProjectHostSetupOverrideHostId(null)
      }
      // Why: only a GitHub PR re-resolves on the new host; other review bases are kept as before.
      if (options.preserveStartFrom && smartSourceSelectionRef.current?.kind === 'github-pr') {
        smartSourceSelectionRef.current = retargetGitHubPrStartPointSelection(
          smartSourceSelectionRef.current,
          value
        )
        setBaseBranch(undefined)
        setCompareBaseRef(undefined)
        setPushTarget(undefined)
        setBranchNameOverride(undefined)
        setBranchNameOverridePreservesNameEdits(false)
        branchAutoNameRef.current = ''
        setForkPushWarning(null)
      }
      if (!options.preserveStartFrom) {
        smartSourceSelectionRef.current = null
        setLinkedIssue('')
        setLinkedPR(null)
        setLinkedGitLabIssue(null)
        setLinkedGitLabMR(null)
        // Keep workspace-scoped Jira/Linear sources while changing their implementation repo; repo-scoped sources reset.
        if (linkedWorkItem && !shouldPreserveWorkspaceSourceOnRepoChange(linkedWorkItem)) {
          setLinkedWorkItem(null)
          setLinkedTaskSourceContext(null)
        }
      }
      setSparseEnabled(false)
      setSparseDirectories('')
      setSparseSelectedPresetId(null)
      // Clear repo-scoped checkout source to undefined so the new repo supplies its effective base.
      if (!options.preserveStartFrom) {
        setBaseBranch(undefined)
        setCompareBaseRef(undefined)
        setPushTarget(undefined)
        // Why: Linear sources are workspace-scoped, so their canonical branch survives choosing a different implementation repo.
        setBranchNameOverride(preservedLinearBranchName)
        setBranchNameOverridePreservesNameEdits(Boolean(preservedLinearBranchName))
        branchAutoNameRef.current = preservedLinearBranchName ?? ''
        // Clear branch-reuse state on repo switch even when a workspace-scoped Linear override survives (#5181).
        setReuseEligibleBranch(null)
        setReuseSelectedBranch(false)
        setForkPushWarning(null)
        setStartFromResetHint(hint)
      }
    },
    [
      baseBranch,
      linkedWorkItem,
      repoId,
      retargetGitHubPrStartPointSelection,
      setRepoId,
      branchAutoNameRef,
      setBaseBranch,
      setBranchNameOverride,
      setBranchNameOverridePreservesNameEdits,
      setCompareBaseRef,
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
      setSelectedProjectHostSetupOverrideId,
      setSelectedProjectHostSetupOverrideHostId,
      setSparseDirectories,
      setSparseEnabled,
      setSparseSelectedPresetId,
      setStartFromResetHint,
      smartSourceSelectionRef
    ]
  )

  const handleFolderSourceRepoChange = useCallback(
    (value: string): void => {
      if (!folderSourceRepos.some((repo) => repo.id === value)) {
        return
      }
      setRepoId(value)
      smartSourceSelectionRef.current = null
      setLinkedWorkItem((current) =>
        current && !shouldPreserveWorkspaceSourceOnRepoChange(current) ? null : current
      )
      if (linkedWorkItem && !shouldPreserveWorkspaceSourceOnRepoChange(linkedWorkItem)) {
        setLinkedTaskSourceContext(null)
      }
      setLinkedIssue('')
      setLinkedPR(null)
      setLinkedGitLabIssue(null)
      setLinkedGitLabMR(null)
    },
    [
      folderSourceRepos,
      linkedWorkItem,
      setRepoId,
      setLinkedGitLabIssue,
      setLinkedGitLabMR,
      setLinkedIssue,
      setLinkedPR,
      setLinkedTaskSourceContext,
      setLinkedWorkItem,
      smartSourceSelectionRef
    ]
  )

  const handleProjectHostSetupChange = useCallback(
    (setupId: string): void => {
      const matchesSelection = (
        candidate: Pick<ProjectHostSetupOption, 'id' | 'hostId'>
      ): boolean =>
        candidate.id === setupId || getProjectHostSetupSelectionKey(candidate) === setupId
      const option = projectHostSetupOptions.find(matchesSelection)
      // Rebuild new setups through normal eligibility/host/dedupe policy before selecting; raw records can retarget away from the chosen location.
      const target =
        option?.kind === 'ready'
          ? option
          : buildProjectHostSetupOptions({
              projectId: selectedRepoProjectId,
              projectHostSetups: selectCanonicalProjectHostSetups(useAppStore.getState()),
              eligibleRepos: getComposerEligibleRepos(useAppStore.getState().repos),
              hosts: hostOptions
            }).find(
              (candidate): candidate is ReadyProjectHostSetupOption =>
                matchesSelection(candidate) && candidate.kind === 'ready'
            )
      if (!target) {
        return
      }
      // Why: switching run host for the same project must not erase the task/PR source the user is starting from.
      setSelectedProjectHostSetupOverrideId(target.id)
      setSelectedProjectHostSetupOverrideHostId(target.hostId)
      handleRepoChange(target.repoId, {
        preserveStartFrom: true,
        forceResetStartFrom: true
      })
    },
    [
      handleRepoChange,
      hostOptions,
      projectHostSetupOptions,
      selectedRepoProjectId,
      setSelectedProjectHostSetupOverrideId,
      setSelectedProjectHostSetupOverrideHostId
    ]
  )

  return {
    handleRepoChange,
    handleFolderSourceRepoChange,
    handleProjectHostSetupChange
  }
}
