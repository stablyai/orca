import type { ComposerModel } from './composer-model'

type WorkItemSourceActionsInput = Pick<
  ComposerModel,
  | 'branchAutoNameRef'
  | 'lastAutoNameRef'
  | 'name'
  | 'repoId'
  | 'reuseEligibleBranch'
  | 'setBaseBranch'
  | 'setBaseBranchNamesWorkspace'
  | 'setBranchNameOverride'
  | 'setBranchIntent'
  | 'setBranchNameOverridePreservesNameEdits'
  | 'setCompareBaseRef'
  | 'setForkPushWarning'
  | 'setName'
  | 'setPushTarget'
  | 'setReuseEligibleBranch'
  | 'setReuseSelectedBranch'
  | 'setStartFromResetHint'
  | 'smartSourceSelectionRef'
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
    setBaseBranchNamesWorkspace,
    setBranchNameOverride,
    setBranchIntent,
    setBranchNameOverridePreservesNameEdits,
    setCompareBaseRef,
    setForkPushWarning,
    setName,
    setPushTarget,
    setReuseEligibleBranch,
    setReuseSelectedBranch,
    setStartFromResetHint,
    smartSourceSelectionRef,
    worktreesByRepo
  } = input

  const handleSmartBranchSelect = useCallback(
    (refName: string, localBranchName: string): void => {
      smartSourceSelectionRef.current = null
      const selection = resolveComposerBranchPick({
        refName,
        localBranchName,
        currentName: name,
        lastAutoName: lastAutoNameRef.current,
        worktreeBranches: getComposerRepoWorktreeBranches(worktreesByRepo[repoId] ?? [], repoId)
      })
      setBaseBranch(selection.baseBranch)
      setBaseBranchNamesWorkspace(true)
      setCompareBaseRef(undefined)
      setPushTarget(undefined)
      setStartFromResetHint(null)
      setForkPushWarning(null)
      // Git allows one worktree per branch: visible busy branches cannot reuse (#5181); hidden external conflicts remain backend-checked.
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
      if (
        selection.branchNameOverride &&
        refName !== localBranchName &&
        refName !== `refs/heads/${localBranchName}`
      ) {
        setBranchIntent('open-existing')
      }
    },
    [
      name,
      worktreesByRepo,
      repoId,
      branchAutoNameRef,
      lastAutoNameRef,
      setBaseBranch,
      setBaseBranchNamesWorkspace,
      setBranchNameOverride,
      setBranchIntent,
      setBranchNameOverridePreservesNameEdits,
      setCompareBaseRef,
      setForkPushWarning,
      setName,
      setPushTarget,
      setReuseEligibleBranch,
      setReuseSelectedBranch,
      setStartFromResetHint,
      smartSourceSelectionRef
    ]
  )

  const handleReuseSelectedBranchChange = useCallback(
    (next: boolean): void => {
      if (!reuseEligibleBranch) {
        return
      }
      setReuseSelectedBranch(next)
      // Reuse pins the branch across name edits; opting out restores fresh-branch creation from the ref (#5181).
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
