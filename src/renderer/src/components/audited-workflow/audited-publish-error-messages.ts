// Sanitized, human-readable copy for the Phase 9 publish lane.
//
// TWO `switch` statements with NO default and no fallback return, so
// lint:switch-exhaustiveness fails the build if PUBLISH_REASON_CODES or
// PUBLISH_ADVISORY_CODES gains a member — a new code must be given a message
// deliberately, not fall through to something generic.
//
// THE ADVISORY COPY MUST NEVER READ AS A FAILURE. Every advisory describes a
// publish that SUCCEEDED; only the review request is outstanding. Saying
// otherwise would misrepresent durable state and invite a duplicate push.
import {
  isRetryablePublishReasonCode,
  type PublishAdvisoryCode,
  type PublishReasonCode
} from '../../../../shared/audited-publish-types'
import { translate } from '@/i18n/i18n'

export function getPublishErrorMessage(code: PublishReasonCode): string {
  switch (code) {
    case 'illegal_transition':
      return translate(
        'auto.components.auditedWorkflow.errors.publishIllegalTransition',
        'This task is not ready to publish.'
      )
    case 'lock_contended':
      return translate(
        'auto.components.auditedWorkflow.errors.publishLockContended',
        'Another action is already running for this task. Try again in a moment.'
      )
    case 'task_not_committed':
      return translate(
        'auto.components.auditedWorkflow.errors.publishNotCommitted',
        'This task has no committed change to publish yet.'
      )
    case 'committed_sha_missing':
      return translate(
        'auto.components.auditedWorkflow.errors.publishShaMissing',
        'The commit record is incomplete, so there is nothing safe to publish.'
      )
    case 'commit_attempt_not_completed':
      return translate(
        'auto.components.auditedWorkflow.errors.publishAttemptIncomplete',
        'The commit has not finished recording. Try again in a moment.'
      )
    case 'commit_attempt_sha_mismatch':
      return translate(
        'auto.components.auditedWorkflow.errors.publishShaMismatch',
        'The commit changed since it was recorded. Review the task before publishing.'
      )
    case 'publish_host_unsupported':
      return translate(
        'auto.components.auditedWorkflow.errors.publishHostUnsupported',
        'Publishing is only supported for local repositories.'
      )
    case 'worktree_not_verified':
      return translate(
        'auto.components.auditedWorkflow.errors.publishWorktreeUnverified',
        'The workspace could not be verified, so nothing was published.'
      )
    case 'worktree_identity_changed':
      return translate(
        'auto.components.auditedWorkflow.errors.publishWorktreeChanged',
        'The workspace changed while preparing to publish. Nothing was sent.'
      )
    case 'head_not_at_committed_sha':
      return translate(
        'auto.components.auditedWorkflow.errors.publishHeadMoved',
        'The workspace moved off the committed change, so nothing was published.'
      )
    case 'branch_tip_not_at_committed_sha':
      return translate(
        'auto.components.auditedWorkflow.errors.publishBranchMoved',
        'The branch moved off the committed change, so nothing was published.'
      )
    case 'branch_not_symbolic':
      return translate(
        'auto.components.auditedWorkflow.errors.publishBranchNotSymbolic',
        'The workspace is not on its expected branch, so nothing was published.'
      )
    case 'no_remote_configured':
      return translate(
        'auto.components.auditedWorkflow.errors.publishNoRemote',
        'This repository has no remote configured to publish to.'
      )
    case 'remote_url_unreadable':
      return translate(
        'auto.components.auditedWorkflow.errors.publishRemoteUnreadable',
        'The remote configuration could not be read, so nothing was published.'
      )
    case 'remote_ref_unreadable':
      return translate(
        'auto.components.auditedWorkflow.errors.publishRemoteRefUnreadable',
        'The remote could not be reached. Nothing was published — check your connection and try again.'
      )
    case 'push_rejected_stale_lease':
      return translate(
        'auto.components.auditedWorkflow.errors.publishStaleLease',
        'The remote branch was changed by someone else, so nothing was overwritten. Review the remote before publishing again.'
      )
    case 'push_rejected_non_fast_forward':
      return translate(
        'auto.components.auditedWorkflow.errors.publishNonFastForward',
        'The remote branch has newer commits, so nothing was overwritten.'
      )
    case 'push_auth_failed':
      return translate(
        'auto.components.auditedWorkflow.errors.publishAuthFailed',
        'The remote rejected the credentials. Sign in for this remote, then publish again.'
      )
    case 'push_network_unavailable':
      return translate(
        'auto.components.auditedWorkflow.errors.publishNetworkUnavailable',
        'The remote could not be reached. Nothing was published.'
      )
    case 'push_failed':
      return translate(
        'auto.components.auditedWorkflow.errors.publishFailed',
        'Publishing failed and nothing was changed on the remote.'
      )
    case 'push_evidence_ambiguous':
      return translate(
        'auto.components.auditedWorkflow.errors.publishAmbiguous',
        'The remote is in an unexpected state, so this task is paused for review. Nothing was changed automatically.'
      )
    case 'interrupted':
      return translate(
        'auto.components.auditedWorkflow.errors.publishInterrupted',
        'Publishing was interrupted and did not complete. You can try again.'
      )
  }
}

/**
 * Copy for a review-request outcome on a DURABLE publish.
 *
 * Every non-success message states that the publish succeeded, because it did:
 * the commit is on the remote by the time any advisory can exist.
 */
export function getPublishAdvisoryMessage(code: PublishAdvisoryCode): string {
  switch (code) {
    case 'review_request_created':
      return translate(
        'auto.components.auditedWorkflow.advisories.reviewCreated',
        'Published, and a review request was opened.'
      )
    case 'review_request_already_exists':
      return translate(
        'auto.components.auditedWorkflow.advisories.reviewExists',
        'Published. An existing review request for this branch was reused.'
      )
    case 'review_request_unsupported_provider':
      return translate(
        'auto.components.auditedWorkflow.advisories.reviewUnsupported',
        'Published. This remote does not support review requests, so none was created.'
      )
    case 'review_request_auth_required':
      return translate(
        'auto.components.auditedWorkflow.advisories.reviewAuthRequired',
        'Published. Sign in to the hosting service to open a review request, then try creating it again.'
      )
    case 'review_request_validation_failed':
      return translate(
        'auto.components.auditedWorkflow.advisories.reviewValidationFailed',
        'Published. The hosting service rejected the review request details — correct them, then try again.'
      )
    case 'review_request_deferred':
      return translate(
        'auto.components.auditedWorkflow.advisories.reviewDeferred',
        'Published. The review request could not be created just now — you can try again.'
      )
    case 'review_request_ambiguous':
      return translate(
        'auto.components.auditedWorkflow.advisories.reviewAmbiguous',
        'Published. It is unclear whether a review request was created — trying again is safe and will reuse one if it exists.'
      )
  }
}

/** Whether the Publish button should offer a retry. Server-authored. */
export function isPublishRetryable(code: PublishReasonCode): boolean {
  return isRetryablePublishReasonCode(code)
}
