import type { ComposerModel } from './composer-model'

type WorkItemSourceActionsInput = Pick<
  ComposerModel,
  | 'branchAutoNameRef'
  | 'lastAutoNameRef'
  | 'name'
  | 'repoId'
  | 'reuseEligibleBranch'
  | 'setBaseBranch'
  | 'setBranchNameOverride'
  | 'setBranchNameOverridePreservesNameEdits'
  | 'setCompareBaseRef'
  | 'setForkPushWarning'
  | 'setName'
  | 'setPushTarget'
  | 'setReuseEligibleBranch'
  | 'setReuseSelectedBranch'
  | 'setStartFromResetHint'
  | 'smartGitHubPrStartPointSelectionRef'
  | 'worktreesByRepo'
>

import { useCallback } from 'react'
import {
  resolveComposerBranchPick,
  getComposerRepoWorktreeBranches
} from '../composer-branch-selection'

export function useWorkItemSourceActions(input: WorkItemSourceActionsInput) {
  const {
    branchAutoNameRef,
    lastAutoNameRef,
    name,
    repoId,
    reuseEligibleBranch,
    setBaseBranch,
    setBranchNameOverride,
    setBranchNameOverridePreservesNameEdits,
    setCompareBaseRef,
    setForkPushWarning,
    setName,
    setPushTarget,
    setReuseEligibleBranch,
    setReuseSelectedBranch,
    setStartFromResetHint,
    smartGitHubPrStartPointSelectionRef,
    worktreesByRepo
  } = input

  const handleSmartBranchSelect = useCallback(
    (refName: string, localBranchName: string): void => {
      smartGitHubPrStartPointSelectionRef.current = null
      const selection = resolveComposerBranchPick({
        refName,
        localBranchName,
        currentName: name,
        lastAutoName: lastAutoNameRef.current,
        worktreeBranches: getComposerRepoWorktreeBranches(worktreesByRepo[repoId] ?? [], repoId)
      })
      setBaseBranch(selection.baseBranch)
      setCompareBaseRef(undefined)
      setPushTarget(undefined)
      setStartFromResetHint(null)
      setForkPushWarning(null)
      // Why (#5181): reuse (check out) an existing branch instead of branching off it; git allows a branch in only one worktree, so gate eligibility on that.
      // Note: worktreesByRepo covers only visible worktrees; a branch busy in a hidden external worktree falls through to the backend "already exists locally" check.
      const { reuseEligibleBranch: nextReuseEligibleBranch, defaultReuse } = selection
      setReuseEligibleBranch(nextReuseEligibleBranch)
      setReuseSelectedBranch(defaultReuse)
      setBranchNameOverridePreservesNameEdits(defaultReuse)
      if (selection.name !== undefined && selection.lastAutoName !== undefined) {
        setName(selection.name)
        lastAutoNameRef.current = selection.lastAutoName
        branchAutoNameRef.current = selection.branchNameOverride ? selection.branchAutoName : ''
        setBranchNameOverride(selection.branchNameOverride)
      } else {
        setBranchNameOverride(selection.branchNameOverride)
        branchAutoNameRef.current = selection.branchNameOverride ? selection.branchAutoName : ''
      }
    },
    [
      name,
      worktreesByRepo,
      repoId,
      branchAutoNameRef,
      lastAutoNameRef,
      setBaseBranch,
      setBranchNameOverride,
      setBranchNameOverridePreservesNameEdits,
      setCompareBaseRef,
      setForkPushWarning,
      setName,
      setPushTarget,
      setReuseEligibleBranch,
      setReuseSelectedBranch,
      setStartFromResetHint,
      smartGitHubPrStartPointSelectionRef
    ]
  )

  const handleReuseSelectedBranchChange = useCallback(
    (next: boolean): void => {
      if (!reuseEligibleBranch) {
        return
      }
      setReuseSelectedBranch(next)
      // Why (#5181): reuse pins the existing branch as override (preserved across name edits); opting out drops it so a fresh branch is created from the ref.
      setBranchNameOverridePreservesNameEdits(next)
      setBranchNameOverride(next ? reuseEligibleBranch : undefined)
      if (next) {
        branchAutoNameRef.current = reuseEligibleBranch
      }
    },
    [
      reuseEligibleBranch,
      branchAutoNameRef,
      setBranchNameOverride,
      setBranchNameOverridePreservesNameEdits,
      setReuseSelectedBranch
    ]
  )

  return {
    handleSmartBranchSelect,
    handleReuseSelectedBranchChange
  }
}
