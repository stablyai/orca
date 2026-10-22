import { WORKSPACE_ATTACHMENT_RUNTIME_CAPABILITIES } from './workspace-attachment-capabilities'

export const PROJECT_HOST_SETUP_RUNTIME_CAPABILITY = 'project-host-setup.v1' as const
// Why: older hosts strip `hostId` from setup update/delete and act on the first same-id twin.
export const PROJECT_HOST_SETUP_HOST_TARGET_RUNTIME_CAPABILITY =
  'project-host-setup.host-target.v1' as const
export const WORKSPACE_RUN_CONTEXT_RUNTIME_CAPABILITY = 'workspace-run-context.v1' as const
export const WORKTREE_PROVISIONED_ROOT_RUNTIME_CAPABILITY = 'worktree.provisioned-root.v1' as const
export const WORKTREE_LINKED_WORK_ITEM_CONTEXT_RUNTIME_CAPABILITY =
  'worktree.linked-work-item-context.v1' as const
export const WORKTREE_GITHUB_PR_SUPPRESSION_RUNTIME_CAPABILITY =
  'worktree.github-pr-suppression.v1' as const
// Legacy clients cannot safely derive a branch name from a qualified ref selector.
export const REPO_SEARCH_QUALIFIED_REFS_RUNTIME_CAPABILITY =
  'repo.search-qualified-refs.v1' as const
export const FOLDER_WORKSPACE_PATH_STATUS_RUNTIME_CAPABILITY =
  'folder-workspace.path-status.v1' as const
// Why: older hosts strip worktree.create's clientMutationId, so mobile must only
// replay ambiguous cutovers when the host advertises idempotent create support;
// status.worktreeCreateIdempotency carries the optional host retention policy.
export const WORKTREE_CREATE_IDEMPOTENCY_RUNTIME_CAPABILITY =
  'worktree.create-idempotency.v1' as const
// Scope of the claim: a hook that RUNS and fails cannot delete the checkout. It does not promise
// the hook was found — an SSH host whose orca.yaml cannot be read answers "no hook" and the removal
// proceeds, because a failed read is indistinguishable from an absent file across the relay
// (#20196 tracks the provider contract that would separate them).
// Why (#19334): "accepts --run-hooks" and "refuses to delete when the archive hook fails" were
// indistinguishable from the outside — both take the flag and behave identically on success, so
// the only way to tell an unfixed host apart was to fail a hook and see whether the checkout
// survived. Lifecycle integrations keep teardown evidence inside the checkout and cannot risk
// that. Advertised unconditionally: every build carrying this constant has the gate.
export const WORKTREE_ARCHIVE_FAILURE_BLOCKING_RUNTIME_CAPABILITY =
  'worktree.archive-failure-blocking.v1' as const
export const WORKTREE_VISIBILITY_DEFAULTS_RUNTIME_CAPABILITY =
  'worktree.visibility-defaults.v1' as const
export const WORKTREE_VISIBILITY_SOURCE_DEFAULTS_RUNTIME_CAPABILITY =
  'worktree.visibility-source-defaults.v1' as const
// Why: Git's checkout delete outlives worktree.rm's older client timeouts. A client with this waits
// for the reply and shows `removing` rows as Deleting; one without it is answered on acceptance and
// would re-show that row as a normal workspace, so the host leaves such rows out of its listings.
export const WORKTREE_BACKGROUND_REMOVAL_RUNTIME_CAPABILITY =
  'worktree.background-removal.v1' as const

export const WORKTREE_RUNTIME_CAPABILITIES = [
  PROJECT_HOST_SETUP_RUNTIME_CAPABILITY,
  PROJECT_HOST_SETUP_HOST_TARGET_RUNTIME_CAPABILITY,
  WORKSPACE_RUN_CONTEXT_RUNTIME_CAPABILITY,
  WORKTREE_PROVISIONED_ROOT_RUNTIME_CAPABILITY,
  WORKTREE_LINKED_WORK_ITEM_CONTEXT_RUNTIME_CAPABILITY,
  ...WORKSPACE_ATTACHMENT_RUNTIME_CAPABILITIES,
  WORKTREE_GITHUB_PR_SUPPRESSION_RUNTIME_CAPABILITY,
  REPO_SEARCH_QUALIFIED_REFS_RUNTIME_CAPABILITY,
  FOLDER_WORKSPACE_PATH_STATUS_RUNTIME_CAPABILITY,
  WORKTREE_CREATE_IDEMPOTENCY_RUNTIME_CAPABILITY,
  WORKTREE_ARCHIVE_FAILURE_BLOCKING_RUNTIME_CAPABILITY,
  WORKTREE_VISIBILITY_DEFAULTS_RUNTIME_CAPABILITY,
  WORKTREE_VISIBILITY_SOURCE_DEFAULTS_RUNTIME_CAPABILITY
] as const
