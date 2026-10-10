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
  | 'setSparseDirectories'
  | 'setSparseEnabled'
  | 'setSparseSelectedPresetId'
  | 'setStartFromResetHint'
  | 'smartGitHubPrStartPointSelectionRef'
>

import { useCallback } from 'react'
import {
  isLinearLinkedWorkItem,
  getLinearLinkedWorkItemBranchName
} from '@/lib/linear-linked-work-item'
import { shouldPreserveWorkspaceSourceOnRepoChange } from '../../../../shared/new-workspace/workspace-source'
import {
  buildProjectHostSetupOptions,
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
    setSparseDirectories,
    setSparseEnabled,
    setSparseSelectedPresetId,
    setStartFromResetHint,
    smartGitHubPrStartPointSelectionRef
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
        }
        setRepoId(value)
        return
      }
      // Why: capture a descriptor of the prior Start-from selection so the field can show an inline reset (e.g. "was PR #8778") after it's wiped.
      let hint: string | null = null
      if (!options.preserveStartFrom) {
        if (linkedWorkItem?.type === 'pr' && baseBranch) {
          hint = `was PR #${linkedWorkItem.number}`
        } else if (linkedWorkItem?.type === 'mr' && baseBranch) {
          // Why: GitLab MR convention is `!N`, not `#N` — match the upstream UI so the hint is recognizable.
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
      }
      if (options.preserveStartFrom && smartGitHubPrStartPointSelectionRef.current) {
        smartGitHubPrStartPointSelectionRef.current = retargetGitHubPrStartPointSelection(
          smartGitHubPrStartPointSelectionRef.current,
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
        smartGitHubPrStartPointSelectionRef.current = null
        setLinkedIssue('')
        setLinkedPR(null)
        setLinkedGitLabIssue(null)
        setLinkedGitLabMR(null)
        // Why: a repo change invalidates repo-scoped sources, but Linear and
        // Jira issues are workspace-scoped and must survive choosing the
        // implementation project — not just Linear.
        if (linkedWorkItem && !shouldPreserveWorkspaceSourceOnRepoChange(linkedWorkItem)) {
          setLinkedWorkItem(null)
          setLinkedTaskSourceContext(null)
        }
      }
      setSparseEnabled(false)
      setSparseDirectories('')
      // Why: presets are repo-scoped, so a prior-repo selection is meaningless after a switch.
      setSparseSelectedPresetId(null)
      // Why: Start-from is repo-scoped; reset to undefined so the field falls back to the new repo's effective base ref.
      if (!options.preserveStartFrom) {
        setBaseBranch(undefined)
        setCompareBaseRef(undefined)
        setPushTarget(undefined)
        // Why: Linear sources are workspace-scoped, so their canonical branch survives choosing a different implementation repo.
        setBranchNameOverride(preservedLinearBranchName)
        setBranchNameOverridePreservesNameEdits(Boolean(preservedLinearBranchName))
        branchAutoNameRef.current = preservedLinearBranchName ?? ''
        // Why (#5181): reuse state is branch-scoped, so a repo switch clears it even when a workspace-scoped Linear override is restored.
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
      setSparseDirectories,
      setSparseEnabled,
      setSparseSelectedPresetId,
      setStartFromResetHint,
      smartGitHubPrStartPointSelectionRef
    ]
  )

  const handleFolderSourceRepoChange = useCallback(
    (value: string): void => {
      if (!folderSourceRepos.some((repo) => repo.id === value)) {
        return
      }
      setRepoId(value)
      smartGitHubPrStartPointSelectionRef.current = null
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
      smartGitHubPrStartPointSelectionRef
    ]
  )

  const handleProjectHostSetupChange = useCallback(
    (setupId: string): void => {
      const option = projectHostSetupOptions.find((candidate) => candidate.id === setupId)
      // Why: a just-created setup lands in the store before the memoized picker
      // options refresh. Rebuild through the same builder rather than reading the
      // raw record — repo eligibility, ephemeral-VM/runtime-owned host exclusion,
      // and one-setup-per-host dedupe all decide which setup creation resolves to.
      // Skipping them can retarget to a location other than the one just chosen.
      const target =
        option?.kind === 'ready'
          ? option
          : buildProjectHostSetupOptions({
              projectId: selectedRepoProjectId,
              projectHostSetups: useAppStore.getState().projectHostSetups,
              eligibleRepos: getComposerEligibleRepos(useAppStore.getState().repos),
              hosts: hostOptions
            }).find(
              (candidate): candidate is ReadyProjectHostSetupOption =>
                candidate.id === setupId && candidate.kind === 'ready'
            )
      if (!target) {
        return
      }
      // Why: switching run host for the same project must not erase the task/PR source the user is starting from.
      setSelectedProjectHostSetupOverrideId(target.id)
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
      setSelectedProjectHostSetupOverrideId
    ]
  )

  return {
    handleRepoChange,
    handleFolderSourceRepoChange,
    handleProjectHostSetupChange
  }
}
