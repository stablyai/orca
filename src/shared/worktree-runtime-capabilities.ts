import { WORKSPACE_ATTACHMENT_RUNTIME_CAPABILITIES } from './workspace-attachments/workspace-attachment-capabilities'

export const WORKTREE_RENAME_ERROR_DISMISS_RUNTIME_CAPABILITY =
  'worktree.rename-error-dismiss.v1' as const

export const WORKTREE_OPEN_EXISTING_BRANCH_RUNTIME_CAPABILITY =
  'worktree.open-existing-branch.v1' as const
// Older hosts advertised V2 while still accepting the V1 wire value.
export const WORKTREE_OPEN_EXISTING_BRANCH_V2_RUNTIME_CAPABILITY =
  'worktree.open-existing-branch.v2' as const
export const WORKTREE_OPEN_EXISTING_BRANCH_V2_REQUEST_RUNTIME_CAPABILITY =
  'worktree.open-existing-branch.v2-request.v1' as const

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
// Replay ambiguous creates only with advertised idempotency support; older hosts strip clientMutationId. status.worktreeCreateIdempotency supplies optional retention policy.
export const WORKTREE_CREATE_IDEMPOTENCY_RUNTIME_CAPABILITY =
  'worktree.create-idempotency.v1' as const
export const WORKTREE_REMOVE_BRANCH_POLICY_RUNTIME_CAPABILITY =
  'worktree.remove-branch-policy.v1' as const
// A failed running archive hook blocks deletion. This does not prove a hook was found: unreadable SSH orca.yaml is indistinguishable from absence (#20196).
// Advertise the gate so callers need not risk their checkout by probing a failure (#19334).
export const WORKTREE_ARCHIVE_FAILURE_BLOCKING_RUNTIME_CAPABILITY =
  'worktree.archive-failure-blocking.v1' as const
export const WORKTREE_VISIBILITY_DEFAULTS_RUNTIME_CAPABILITY =
  'worktree.visibility-defaults.v1' as const
export const WORKTREE_VISIBILITY_SOURCE_DEFAULTS_RUNTIME_CAPABILITY =
  'worktree.visibility-source-defaults.v1' as const
// Capable clients wait for deletion and display removing rows. Legacy clients receive acceptance early, so hosts hide those rows to avoid showing them as normal workspaces.
export const WORKTREE_BACKGROUND_REMOVAL_RUNTIME_CAPABILITY =
  'worktree.background-removal.v1' as const

// Hosts that record another owner's verified automation run on the workspaces it creates there.
export const WORKTREE_CLIENT_AUTOMATION_PROVENANCE_RUNTIME_CAPABILITY =
  'worktree.create.client-automation-provenance.v1' as const

// Hosts that save a parent from another Orca store; older hosts strip `crossStoreParent` and write no link.
export const WORKTREE_CROSS_STORE_LINEAGE_RUNTIME_CAPABILITY =
  'worktree.lineage.crossMachine' as const

export function supportsCrossStoreLineage(capabilities: readonly string[] | undefined): boolean {
  return capabilities?.includes(WORKTREE_CROSS_STORE_LINEAGE_RUNTIME_CAPABILITY) === true
}

/** Refuses before any request, so an older host never applies the rest of the change without its parent. */
export function assertCrossStoreLineageSupported(
  capabilities: readonly string[] | undefined,
  hostLabel: string
): void {
  if (!supportsCrossStoreLineage(capabilities)) {
    throw new Error(
      `Update Orca on ${hostLabel} to nest workspaces under a parent on another machine. Nothing was changed.`
    )
  }
}

// Hosts that accept a folder workspace as `worktree.set`'s parent; older hosts refuse it as not found.
export const WORKTREE_SET_FOLDER_PARENT_RUNTIME_CAPABILITY =
  'worktree.set.folder-parent.v1' as const

export function supportsFolderParent(capabilities: readonly string[] | undefined): boolean {
  return capabilities?.includes(WORKTREE_SET_FOLDER_PARENT_RUNTIME_CAPABILITY) === true
}

/** Refuses before any request, so an older host's "not found" never reads as a mistyped folder. */
export function assertFolderParentSetSupported(
  capabilities: readonly string[] | undefined,
  hostLabel: string
): void {
  if (!supportsFolderParent(capabilities)) {
    throw new Error(
      `Update Orca on ${hostLabel} to attach a worktree to a folder workspace. Nothing was changed.`
    )
  }
}

// Hosts that run an existing worktree's setup once the user approves that worktree's content.
export const WORKTREE_RUN_APPROVED_SETUP_RUNTIME_CAPABILITY =
  'worktree.run-approved-setup.v1' as const

export const WORKTREE_RUNTIME_CAPABILITIES = [
  WORKTREE_RENAME_ERROR_DISMISS_RUNTIME_CAPABILITY,
  WORKTREE_OPEN_EXISTING_BRANCH_RUNTIME_CAPABILITY,
  WORKTREE_OPEN_EXISTING_BRANCH_V2_RUNTIME_CAPABILITY,
  WORKTREE_OPEN_EXISTING_BRANCH_V2_REQUEST_RUNTIME_CAPABILITY,
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
  WORKTREE_REMOVE_BRANCH_POLICY_RUNTIME_CAPABILITY,
  WORKTREE_VISIBILITY_DEFAULTS_RUNTIME_CAPABILITY,
  WORKTREE_VISIBILITY_SOURCE_DEFAULTS_RUNTIME_CAPABILITY,
  WORKTREE_CLIENT_AUTOMATION_PROVENANCE_RUNTIME_CAPABILITY,
  WORKTREE_CROSS_STORE_LINEAGE_RUNTIME_CAPABILITY,
  WORKTREE_SET_FOLDER_PARENT_RUNTIME_CAPABILITY,
  WORKTREE_RUN_APPROVED_SETUP_RUNTIME_CAPABILITY
] as const
