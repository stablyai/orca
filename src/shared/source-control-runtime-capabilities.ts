export const GITHUB_MARK_PR_READY_RUNTIME_CAPABILITY = 'github.markPRReadyForReview' as const
export const GITHUB_MARK_PR_READY_UPDATE_REQUIRED_MESSAGE =
  'Marking a pull request ready requires a newer Orca server. Update the server and try again.'
export const GITLAB_READY_FOR_REVIEW_RUNTIME_CAPABILITY =
  'gitlab.updateMR.readyForReview.v1' as const
export const GITLAB_READY_FOR_REVIEW_UPDATE_REQUIRED_MESSAGE =
  'Marking a merge request ready requires a newer Orca server. Update the server and try again.'
// Commit-message generation: the host plans Antigravity with the model the user configured.
export const ANTIGRAVITY_CONFIGURED_MODEL_RUNTIME_CAPABILITY =
  'git.antigravity-configured-model.v1' as const

export const SOURCE_CONTROL_RUNTIME_CAPABILITIES = [
  ANTIGRAVITY_CONFIGURED_MODEL_RUNTIME_CAPABILITY,
  GITHUB_MARK_PR_READY_RUNTIME_CAPABILITY,
  GITLAB_READY_FOR_REVIEW_RUNTIME_CAPABILITY
] as const
