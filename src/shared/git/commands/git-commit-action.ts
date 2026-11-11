export type GitCommitAction = 'cherry-pick' | 'revert'

export type GitCommitActionResult = {
  outcome: 'landed' | 'conflicted' | 'refused' | 'landed-with-warning' | 'empty'
  commitId?: string
  branch?: string
  message?: string
}

export const GIT_REVERT_CONFLICT_CLIENT_CAPABILITY = 'git.conflict-operation.revert.v1' as const
