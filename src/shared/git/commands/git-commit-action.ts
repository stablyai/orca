export type GitCommitAction = 'cherry-pick' | 'revert'

export type GitCommitActionResult = {
  outcome: 'landed' | 'conflicted' | 'refused' | 'landed-with-warning' | 'empty'
  commitId?: string
  branch?: string
  message?: string
}
