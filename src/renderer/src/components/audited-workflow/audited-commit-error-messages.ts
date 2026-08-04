// Sanitized, human-readable copy for the Phase 8 approval + commit lane.
//
// A `switch` with NO default and no fallback return, so lint:switch-exhaustiveness
// fails the build if COMMIT_REASON_CODES or APPROVAL_REASON_CODES gains a member —
// a new code must be given a message deliberately, not fall through to something
// generic.
import {
  isRetryableCommitReasonCode,
  type CommitAdvisoryCode,
  type CommitReasonCode
} from '../../../../shared/audited-commit-types'
import type { ApprovalReasonCode } from '../../../../shared/audited-workflow-types'
import { translate } from '@/i18n/i18n'

export function getCommitErrorMessage(code: CommitReasonCode): string {
  switch (code) {
    case 'illegal_transition':
      return translate(
        'auto.components.auditedWorkflow.errors.commitIllegalTransition',
        'This task is not ready to commit.'
      )
    case 'lock_contended':
      return translate(
        'auto.components.auditedWorkflow.errors.commitLockContended',
        'Another action is already running for this task. Try again in a moment.'
      )
    case 'no_approval':
      return translate(
        'auto.components.auditedWorkflow.errors.commitNoApproval',
        'This change needs your approval before it can be committed.'
      )
    case 'approval_expired':
      return translate(
        'auto.components.auditedWorkflow.errors.commitApprovalExpired',
        'The approval expired. Approve again to commit.'
      )
    case 'approval_revoked':
      return translate(
        'auto.components.auditedWorkflow.errors.commitApprovalRevoked',
        'The approval was revoked. Approve again to commit.'
      )
    case 'approval_already_consumed':
      return translate(
        'auto.components.auditedWorkflow.errors.commitApprovalConsumed',
        'That approval was already used for a commit attempt. Approve again to retry.'
      )
    case 'approval_binding_mismatch':
      return translate(
        'auto.components.auditedWorkflow.errors.commitApprovalBinding',
        'The approval no longer matches the reviewed change. Run the audit again.'
      )
    case 'candidate_superseded':
      return translate(
        'auto.components.auditedWorkflow.errors.commitCandidateSuperseded',
        'Newer work replaced the reviewed change. Run the audit again.'
      )
    case 'candidate_drift':
      return translate(
        'auto.components.auditedWorkflow.errors.commitCandidateDrift',
        'The working tree changed since the review, so nothing was committed. Run the audit again.'
      )
    case 'worktree_not_verified':
      return translate(
        'auto.components.auditedWorkflow.errors.commitWorktreeNotVerified',
        'The workspace could not be verified, so nothing was committed.'
      )
    case 'worktree_identity_changed':
      return translate(
        'auto.components.auditedWorkflow.errors.commitWorktreeIdentityChanged',
        'The workspace changed while preparing the commit. Try again.'
      )
    case 'execution_in_progress':
      return translate(
        'auto.components.auditedWorkflow.errors.commitExecutionInProgress',
        'A code change is still running. The commit can start once it finishes.'
      )
    case 'code_audit_in_progress':
      return translate(
        'auto.components.auditedWorkflow.errors.commitAuditInProgress',
        'A review is still running. The commit can start once it finishes.'
      )
    case 'message_empty_subject':
      return translate(
        'auto.components.auditedWorkflow.errors.commitMessageEmpty',
        'Enter a commit message.'
      )
    case 'message_contains_nul':
      return translate(
        'auto.components.auditedWorkflow.errors.commitMessageNul',
        'The commit message contains characters Git cannot store.'
      )
    case 'message_too_large':
      return translate(
        'auto.components.auditedWorkflow.errors.commitMessageTooLarge',
        'The commit message is too long.'
      )
    case 'message_invalid_encoding':
      return translate(
        'auto.components.auditedWorkflow.errors.commitMessageEncoding',
        'The commit message contains invalid characters.'
      )
    case 'candidate_objects_unavailable':
      return translate(
        'auto.components.auditedWorkflow.errors.commitObjectsUnavailable',
        'The reviewed change is no longer stored locally. Run the audit again to rebuild it.'
      )
    case 'promotion_failed':
      return translate(
        'auto.components.auditedWorkflow.errors.commitPromotionFailed',
        'The reviewed change could not be prepared for commit. Nothing was committed.'
      )
    case 'promoted_tree_unresolvable':
      return translate(
        'auto.components.auditedWorkflow.errors.commitPromotedUnresolvable',
        'The prepared change could not be read back, so nothing was committed.'
      )
    case 'materialization_failed':
      return translate(
        'auto.components.auditedWorkflow.errors.commitMaterializationFailed',
        'The change set could not be rebuilt for commit. Nothing was committed.'
      )
    case 'materialized_tree_mismatch':
      return translate(
        'auto.components.auditedWorkflow.errors.commitTreeMismatch',
        'The working tree no longer matches what was approved, so nothing was committed. Run the audit again.'
      )
    case 'commit_tree_failed':
      return translate(
        'auto.components.auditedWorkflow.errors.commitTreeFailed',
        'Git could not create the commit. Nothing was committed.'
      )
    case 'ref_update_failed':
      return translate(
        'auto.components.auditedWorkflow.errors.commitRefUpdateFailed',
        'Git could not update the branch. Nothing was committed.'
      )
    case 'branch_ref_moved':
      return translate(
        'auto.components.auditedWorkflow.errors.commitBranchMoved',
        'The branch moved while committing, so nothing was committed.'
      )
    case 'commit_host_unsupported':
      return translate(
        'auto.components.auditedWorkflow.errors.commitHostUnsupported',
        'Audited commits currently run only on a local worktree, not over WSL or SSH.'
      )
    case 'index_refresh_failed':
      return translate(
        'auto.components.auditedWorkflow.errors.commitIndexRefreshFailed',
        'The commit succeeded, but Git’s staged-file view could not be refreshed.'
      )
    case 'interrupted':
      return translate(
        'auto.components.auditedWorkflow.errors.commitInterrupted',
        'The commit was interrupted before the branch moved. Nothing was committed.'
      )
    case 'evidence_ambiguous':
      return translate(
        'auto.components.auditedWorkflow.errors.commitEvidenceAmbiguous',
        'The commit left an unclear state that Orca will not change automatically. Inspect the repository before retrying.'
      )
  }
}

export function getApprovalErrorMessage(code: ApprovalReasonCode): string {
  switch (code) {
    case 'approval_granted':
      return translate(
        'auto.components.auditedWorkflow.errors.approvalGranted',
        'Approved for commit.'
      )
    case 'approval_consumed':
      return translate(
        'auto.components.auditedWorkflow.errors.approvalConsumed',
        'That approval was already used.'
      )
    case 'approval_revoked':
      return translate(
        'auto.components.auditedWorkflow.errors.approvalRevoked',
        'The approval was revoked.'
      )
    case 'approval_expired':
      return translate(
        'auto.components.auditedWorkflow.errors.approvalExpired',
        'The approval expired. Approve again to commit.'
      )
    case 'not_awaiting_approval':
      return translate(
        'auto.components.auditedWorkflow.errors.approvalNotAwaiting',
        'This task is not waiting for approval.'
      )
    case 'approver_identity_invalid':
      return translate(
        'auto.components.auditedWorkflow.errors.approvalIdentityInvalid',
        'The approval could not be attributed, so it was refused.'
      )
    case 'worktree_missing_or_outside_managed_tree':
      return translate(
        'auto.components.auditedWorkflow.errors.approvalWorktreeMissing',
        'The workspace is missing or outside the managed folder.'
      )
    case 'no_audit_approved_candidate':
      return translate(
        'auto.components.auditedWorkflow.errors.approvalNoAuditApproval',
        'The code review has not approved this change yet.'
      )
    case 'candidate_identity_changed':
      return translate(
        'auto.components.auditedWorkflow.errors.approvalCandidateChanged',
        'The change moved on since the review. Run the audit again.'
      )
    case 'no_pending_approval':
      return translate(
        'auto.components.auditedWorkflow.errors.approvalNonePending',
        'There is no approval to revoke.'
      )
    case 'approval_binding_mismatch':
      return translate(
        'auto.components.auditedWorkflow.errors.approvalBindingMismatch',
        'The approval no longer matches the reviewed change.'
      )
    case 'approval_already_consumed':
      return translate(
        'auto.components.auditedWorkflow.errors.approvalAlreadyConsumed',
        'That approval was already used for a commit attempt.'
      )
    case 'ttl_preset_invalid':
      return translate(
        'auto.components.auditedWorkflow.errors.approvalTtlInvalid',
        'That approval duration is not available.'
      )
    case 'lock_contended':
      return translate(
        'auto.components.auditedWorkflow.errors.approvalLockContended',
        'Another action is already running for this task. Try again in a moment.'
      )
  }
}

/**
 * Copy for a condition observed AFTER the commit is durable.
 *
 * Deliberately worded as a follow-up condition, never as a commit failure: the
 * commit object, the ref update, and the recorded SHA are all correct.
 */
export function getCommitAdvisoryMessage(code: CommitAdvisoryCode): string {
  switch (code) {
    case 'post_commit_drift_detected':
      return translate(
        'auto.components.auditedWorkflow.errors.commitAdvisoryDrift',
        'The commit succeeded. The working tree has changes made after the commit, which are not included in it.'
      )
    case 'index_refresh_failed':
      return translate(
        'auto.components.auditedWorkflow.errors.commitAdvisoryIndexRefresh',
        'The commit succeeded. Git’s staged-file view may look out of date until you refresh it.'
      )
  }
}

/**
 * Delegates to the SHARED authority so the button and the server cannot
 * disagree — this only controls what is drawn, never what is legal.
 */
export function isRetryableCommitCode(code: CommitReasonCode): boolean {
  return isRetryableCommitReasonCode(code)
}
