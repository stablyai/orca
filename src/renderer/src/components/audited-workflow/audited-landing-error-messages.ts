// Sanitized, human-readable copy for the Phase 10 landing lane.
//
// TWO `switch` statements with NO default and no fallback return, so
// lint:switch-exhaustiveness fails the build if LANDING_REASON_CODES or
// LANDING_ADVISORY_CODES gains a member — a new code must be given a message
// deliberately, not fall through to something generic.
//
// THE ADVISORY COPY MUST NEVER READ AS A FAILURE. Every advisory describes a land
// that SUCCEEDED — the branch moved — and only the working-tree update is
// outstanding. Saying otherwise would misrepresent durable state and invite a
// duplicate land.
//
// NOTHING IDENTIFYING APPEARS IN ANY STRING: no path, branch, sha, or Git output.
// "your repository" is deliberately vague, because naming it would leak the one
// path this feature must never project.
import {
  isRetryableLandingReasonCode,
  type LandingAdvisoryCode
} from '../../../../shared/audited-landing-types'
import type { LandingReasonCode } from '../../../../shared/audited-workflow-types'
import { translate } from '@/i18n/i18n'

export function getLandingErrorMessage(code: LandingReasonCode): string {
  switch (code) {
    case 'landed':
      return translate(
        'auto.components.auditedWorkflow.errors.landLanded',
        'The change is in your repository.'
      )
    case 'landed_recovered':
      return translate(
        'auto.components.auditedWorkflow.errors.landLandedRecovered',
        'The change was already in your repository.'
      )
    case 'integration_required':
      return translate(
        'auto.components.auditedWorkflow.errors.landIntegrationRequired',
        'Your branch has changes this task was not built on, so it cannot be fast-forwarded. Merge or rebase manually.'
      )
    case 'task_not_committed':
      return translate(
        'auto.components.auditedWorkflow.errors.landNotCommitted',
        'This task has no committed change to land yet.'
      )
    case 'committed_candidate_invalid':
      return translate(
        'auto.components.auditedWorkflow.errors.landCandidateInvalid',
        'The commit record is incomplete, so there is nothing safe to land.'
      )
    case 'source_repo_mismatch':
      return translate(
        'auto.components.auditedWorkflow.errors.landRepoMismatch',
        'Your repository is not the one this task was created from.'
      )
    case 'source_repo_missing':
      return translate(
        'auto.components.auditedWorkflow.errors.landRepoMissing',
        'Your repository could not be found or read.'
      )
    case 'source_repo_dirty':
      return translate(
        'auto.components.auditedWorkflow.errors.landRepoDirty',
        'Your repository has uncommitted changes. Commit or stash them, then land again.'
      )
    case 'source_repo_detached_or_invalid_branch':
      return translate(
        'auto.components.auditedWorkflow.errors.landRepoDetached',
        'Your repository is not on the branch this task targets.'
      )
    case 'source_repo_not_at_base_commit':
      return translate(
        'auto.components.auditedWorkflow.errors.landRepoNotAtBase',
        'Your branch has moved since this task started. Update it, then land again.'
      )
    case 'source_repo_already_at_candidate':
      return translate(
        'auto.components.auditedWorkflow.errors.landAlreadyAtCandidate',
        'Your branch already carries this change.'
      )
    case 'source_repo_branch_not_checked_out':
      return translate(
        'auto.components.auditedWorkflow.errors.landBranchNotCheckedOut',
        'The target branch must be checked out in your repository, and not in another worktree.'
      )
    case 'fast_forward_failed':
      return translate(
        'auto.components.auditedWorkflow.errors.landFastForwardFailed',
        'The branch could not be moved. Nothing in your repository was changed.'
      )
    case 'lock_contended':
      return translate(
        'auto.components.auditedWorkflow.errors.landLockContended',
        'Another action is already running for this task. Try again in a moment.'
      )
    case 'illegal_transition':
      return translate(
        'auto.components.auditedWorkflow.errors.landIllegalTransition',
        'This task is not ready to land.'
      )
    case 'landing_host_unsupported':
      return translate(
        'auto.components.auditedWorkflow.errors.landHostUnsupported',
        'Landing is only supported for local repositories.'
      )
    case 'worktree_not_verified':
      return translate(
        'auto.components.auditedWorkflow.errors.landWorktreeUnverified',
        'The workspace could not be verified, so nothing was landed.'
      )
    case 'worktree_identity_changed':
      return translate(
        'auto.components.auditedWorkflow.errors.landWorktreeChanged',
        'The workspace changed while preparing to land. Try again.'
      )
    case 'commit_attempt_not_completed':
      return translate(
        'auto.components.auditedWorkflow.errors.landCommitIncomplete',
        'The commit has not finished recording. Try again in a moment.'
      )
    case 'task_not_published':
      return translate(
        'auto.components.auditedWorkflow.errors.landNotPublished',
        'Publish this change before landing it, so the work exists somewhere other than this machine.'
      )
    case 'publish_sha_mismatch':
      return translate(
        'auto.components.auditedWorkflow.errors.landPublishShaMismatch',
        'The published change does not match this commit. Publish again before landing.'
      )
    case 'publish_not_confirmed':
      return translate(
        'auto.components.auditedWorkflow.errors.landPublishUnconfirmed',
        'The change was not confirmed on the remote. Recheck the publish result before landing.'
      )
    case 'publish_in_progress':
      return translate(
        'auto.components.auditedWorkflow.errors.landPublishInProgress',
        'Publishing is still in progress. Wait for it to finish, then land.'
      )
    case 'execution_in_progress':
      return translate(
        'auto.components.auditedWorkflow.errors.landExecutionInProgress',
        'The agent is still running for this task.'
      )
    case 'code_audit_in_progress':
      return translate(
        'auto.components.auditedWorkflow.errors.landCodeAuditInProgress',
        'The code audit is still running for this task.'
      )
    case 'landing_evidence_ambiguous':
      return translate(
        'auto.components.auditedWorkflow.errors.landEvidenceAmbiguous',
        'Your repository is in an unexpected state, so this task is paused for review.'
      )
    case 'interrupted':
      return translate(
        'auto.components.auditedWorkflow.errors.landInterrupted',
        'Landing was interrupted and nothing was changed. You can land again.'
      )
  }
}

/**
 * Copy for a condition observed AFTER the branch moved.
 *
 * Every message here states the land SUCCEEDED first, because it did — the
 * caveat is always about the working copy, never the history.
 */
export function getLandingAdvisoryMessage(code: LandingAdvisoryCode): string {
  switch (code) {
    case 'worktree_update_failed':
      return translate(
        'auto.components.auditedWorkflow.landing.advisoryWorktreeUpdateFailed',
        'Landed. Your files were not refreshed, so check out the branch again to update them.'
      )
    case 'worktree_verify_failed':
      return translate(
        'auto.components.auditedWorkflow.landing.advisoryVerifyFailed',
        'Landed, but the result could not be confirmed. Check your repository.'
      )
    case 'source_repo_drifted':
      return translate(
        'auto.components.auditedWorkflow.landing.advisoryDrifted',
        'Landed. Your repository changed while landing, so review its current state.'
      )
  }
}

export function isLandingRetryable(code: LandingReasonCode): boolean {
  return isRetryableLandingReasonCode(code)
}
