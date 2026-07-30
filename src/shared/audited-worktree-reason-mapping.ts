// Total mappings from the detailed WorktreeReasonCode to the two generic block
// codes and to reconciliation classification. Exhaustive switches with no
// `default` and no casts, so lint:switch-exhaustiveness fails on an unmapped
// addition rather than letting one silently fall through.
import type { WorktreeReasonCode } from './audited-worktree-types'
import type {
  BlockReasonCode,
  ReconcileClass,
  ReconcileReasonCode
} from './audited-workflow-types'

export function mapWorktreeReasonToBlockReason(code: WorktreeReasonCode): BlockReasonCode {
  switch (code) {
    case 'unsupported_host':
    case 'managed_root_unavailable':
    case 'managed_root_escapes_workspace':
    case 'managed_root_inside_source_repo':
    case 'source_repo_inside_managed_root':
    case 'branch_already_exists':
    case 'worktree_path_occupied':
    case 'base_commit_unresolvable':
    case 'git_worktree_add_failed':
    case 'provision_evidence_ambiguous':
    case 'worktree_never_provisioned':
      return 'worktree_provision_failed'
    case 'worktree_missing':
    case 'worktree_path_outside_managed_root':
    case 'worktree_path_mismatch':
    case 'repository_identity_mismatch':
    case 'head_not_symbolic':
    case 'head_branch_mismatch':
    case 'head_moved_from_base_commit':
    case 'branch_tip_moved_from_base_commit':
    case 'worktree_unreadable':
      return 'worktree_drift_detected'
  }
}

export function mapWorktreeReasonToReconcileReason(code: WorktreeReasonCode): ReconcileReasonCode {
  switch (code) {
    case 'unsupported_host':
    case 'managed_root_unavailable':
    case 'base_commit_unresolvable':
    case 'git_worktree_add_failed':
    case 'repository_identity_mismatch':
    case 'worktree_never_provisioned':
      return 'task_dir_or_state_invalid'
    case 'managed_root_escapes_workspace':
    case 'managed_root_inside_source_repo':
    case 'source_repo_inside_managed_root':
    case 'worktree_path_outside_managed_root':
    case 'worktree_path_mismatch':
      return 'worktree_path_outside_managed_tree'
    case 'branch_already_exists':
    case 'worktree_path_occupied':
    case 'provision_evidence_ambiguous':
      return 'commit_attempt_evidence_ambiguous'
    case 'worktree_missing':
      return 'worktree_missing'
    case 'head_not_symbolic':
    case 'worktree_unreadable':
      return 'worktree_head_unreadable'
    case 'head_branch_mismatch':
    case 'head_moved_from_base_commit':
    case 'branch_tip_moved_from_base_commit':
      return 'worktree_head_base_commit_mismatch'
  }
}

// Note: this `failed` is a ReconcileClass (task-level classification), unrelated
// to the attempt-level failed_ambiguous/failed_no_effect statuses.
export function mapWorktreeReasonToReconcileClass(code: WorktreeReasonCode): ReconcileClass {
  switch (code) {
    case 'managed_root_unavailable':
    case 'branch_already_exists':
    case 'worktree_path_occupied':
    case 'git_worktree_add_failed':
    case 'provision_evidence_ambiguous':
    case 'worktree_unreadable':
    case 'worktree_never_provisioned':
      return 'needs_attention'
    case 'unsupported_host':
    case 'managed_root_escapes_workspace':
    case 'managed_root_inside_source_repo':
    case 'source_repo_inside_managed_root':
    case 'base_commit_unresolvable':
    case 'worktree_missing':
    case 'worktree_path_outside_managed_root':
    case 'worktree_path_mismatch':
    case 'repository_identity_mismatch':
    case 'head_not_symbolic':
    case 'head_branch_mismatch':
    case 'head_moved_from_base_commit':
    case 'branch_tip_moved_from_base_commit':
      return 'failed'
  }
}
