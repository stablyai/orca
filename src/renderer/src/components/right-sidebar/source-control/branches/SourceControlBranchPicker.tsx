import { useCallback } from 'react'
import type { SourceControlPanelModel } from '../panel/use-panel-model'
import { requireGitOwnerTarget } from '../sync/worktree-git-owner-target'
import { WorkspaceBranchPicker } from './WorkspaceBranchPicker'

export function SourceControlBranchPicker({ model }: { model: SourceControlPanelModel }) {
  const {
    activeWorktree,
    activeWorktreeId,
    activeRepoTarget,
    activeRepo,
    branchName,
    recordBranchSwitchOutcome,
    refreshActiveGitStatusAfterMutation
  } = model
  const onLanded = useCallback(
    () => recordBranchSwitchOutcome(refreshActiveGitStatusAfterMutation),
    [recordBranchSwitchOutcome, refreshActiveGitStatusAfterMutation]
  )
  if (!activeWorktree || !activeWorktreeId || !activeRepo || !activeRepoTarget) {
    return null
  }
  return (
    <WorkspaceBranchPicker
      worktreeId={activeWorktreeId}
      worktreePath={activeWorktree.path}
      hostId={activeWorktree.hostId ?? 'local'}
      repoId={activeRepo.id}
      target={requireGitOwnerTarget(activeRepoTarget)}
      branch={branchName}
      onLanded={onLanded}
    />
  )
}
