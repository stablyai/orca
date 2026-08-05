// Maps closed plan-review reason codes to localized, user-safe messages. Never a
// raw exception message, path, argv, or agent output — main produces closed
// codes precisely so none of that can reach here.
//
// Exhaustive switches with no `default`, so lint:switch-exhaustiveness fails on
// an unmapped addition rather than letting one silently fall through.
import { translate } from '@/i18n/i18n'
import {
  isRetryablePlanReviewReasonCode,
  type PlanApprovalReasonCode,
  type PlanReviewReasonCode,
  type PlanRevisionReasonCode
} from '../../../../shared/audited-plan-artifact-types'
import { translateNoToolsReasonCode } from './audited-no-tools-error-messages'

export function getPlanReviewErrorMessage(reasonCode: PlanReviewReasonCode): string {
  switch (reasonCode) {
    case 'illegal_transition':
      return translate(
        'auto.components.auditedWorkflow.errors.planReviewIllegalTransition',
        'This plan cannot be reviewed right now.'
      )
    case 'lock_contended':
      return translate(
        'auto.components.auditedWorkflow.errors.planReviewLockContended',
        'A review is already in progress for this task.'
      )
    case 'worktree_not_verified':
      return translate(
        'auto.components.auditedWorkflow.errors.planReviewWorktreeNotVerified',
        'The worktree could not be verified, so nothing was started.'
      )
    case 'artifact_unavailable':
      return translate(
        'auto.components.auditedWorkflow.errors.planReviewArtifactUnavailable',
        'The plan could not be loaded.'
      )
    case 'artifact_superseded':
      return translate(
        'auto.components.auditedWorkflow.errors.planReviewArtifactSuperseded',
        'The plan changed while the review was running, so the result was discarded.'
      )
    case 'task_state_changed':
      return translate(
        'auto.components.auditedWorkflow.errors.planReviewTaskStateChanged',
        'The task moved on while the review was running, so the result was discarded.'
      )
    case 'acceptance_criteria_unavailable':
      // Points at triage, because that is where the criteria come from and the
      // only place the user can act.
      return translate(
        'auto.components.auditedWorkflow.errors.planReviewCriteriaUnavailable',
        'This task has no acceptance criteria to review against. Run triage again first.'
      )
    case 'worktree_identity_changed':
      return translate(
        'auto.components.auditedWorkflow.errors.planReviewWorktreeIdentityChanged',
        'The worktree changed while the review was starting, so nothing was run. Try again.'
      )
    case 'provider_not_configured':
      return translate(
        'auto.components.auditedWorkflow.errors.planReviewProviderNotConfigured',
        'The Codex provider key is missing or unreadable. Set it again in Settings.'
      )
    case 'provider_settings_invalid':
      return translate(
        'auto.components.auditedWorkflow.errors.planReviewProviderSettingsInvalid',
        'The Codex provider configuration is not usable, so nothing was run.'
      )
    case 'provider_storage_unavailable':
      // Says only what was observed: the question could not be answered. Does
      // not claim a key is missing (an absence we did not see) or present.
      return translate(
        'auto.components.auditedWorkflow.errors.planReviewProviderStorageUnavailable',
        'Orca could not check the Codex provider settings, so nothing was run. You can retry.'
      )
    case 'credential_delivery_unavailable':
      // Must NOT say "configure a key" — one exists. Telling a user to configure
      // something they already configured sends them in circles.
      return translate(
        'auto.components.auditedWorkflow.errors.planReviewCredentialDeliveryUnavailable',
        'This provider is configured, but Orca cannot yet deliver its credential securely, so the review was not run.'
      )
    case 'launch_plan_invalid':
      // Deliberately does NOT hint that a flag could be relaxed: the refusal is
      // the safety property, not a misconfiguration to work around.
      return translate(
        'auto.components.auditedWorkflow.errors.planReviewLaunchPlanInvalid',
        'The review could not be started safely, so it was not run.'
      )
    case 'codex_not_found':
      return translate(
        'auto.components.auditedWorkflow.errors.planReviewCodexNotFound',
        'Codex was not found on your PATH. Install it, then retry.'
      )
    case 'spawn_failed':
      return translate(
        'auto.components.auditedWorkflow.errors.planReviewSpawnFailed',
        'Codex could not be started. You can retry.'
      )
    case 'exit_nonzero':
      return translate(
        'auto.components.auditedWorkflow.errors.planReviewExitNonzero',
        'Codex exited with an error. You can retry.'
      )
    case 'empty_output':
      return translate(
        'auto.components.auditedWorkflow.errors.planReviewEmptyOutput',
        'The review finished without producing a verdict. You can retry.'
      )
    case 'output_too_large':
      return translate(
        'auto.components.auditedWorkflow.errors.planReviewOutputTooLarge',
        'The review produced too much output and was stopped.'
      )
    case 'timeout':
      return translate(
        'auto.components.auditedWorkflow.errors.planReviewTimeout',
        'The review timed out and was stopped. You can retry.'
      )
    case 'cancelled_by_user':
      return translate(
        'auto.components.auditedWorkflow.errors.planReviewCancelled',
        'The review was cancelled.'
      )
    case 'interrupted':
      return translate(
        'auto.components.auditedWorkflow.errors.planReviewInterrupted',
        'The review was interrupted before it finished. You can retry.'
      )
    case 'verdict_unparseable':
      return translate(
        'auto.components.auditedWorkflow.errors.planReviewUnparseable',
        'Codex did not return a usable verdict, so the plan was not accepted.'
      )
    case 'unexpected_commit_detected':
      return translate(
        'auto.components.auditedWorkflow.errors.planReviewUnexpectedCommit',
        'The worktree changed unexpectedly during the review, so the result was refused.'
      )
    // The no-tools transport codes share their text with the code-audit lane:
    // the same transport produces them, so the same condition must read the same
    // way in both places.
    case 'api_unauthorized':
    case 'api_rate_limited':
    case 'api_unavailable':
    case 'api_timeout':
    case 'response_malformed':
    case 'context_limit_exceeded':
    case 'bundle_too_large':
    case 'redaction_failed':
    case 'context_request_invalid':
    case 'context_budget_exhausted':
      return translateNoToolsReasonCode(reasonCode, translate)
  }
}

export function getPlanApprovalErrorMessage(reasonCode: PlanApprovalReasonCode): string {
  switch (reasonCode) {
    case 'illegal_transition':
      return translate(
        'auto.components.auditedWorkflow.errors.planApprovalIllegalTransition',
        'This plan cannot be approved right now.'
      )
    case 'lock_contended':
      return translate(
        'auto.components.auditedWorkflow.errors.planApprovalLockContended',
        'Something else changed this task. Refresh and try again.'
      )
    case 'no_approved_verdict':
      return translate(
        'auto.components.auditedWorkflow.errors.planApprovalNoVerdict',
        'This plan has not been accepted by a Codex review yet.'
      )
    case 'artifact_superseded':
      return translate(
        'auto.components.auditedWorkflow.errors.planApprovalSuperseded',
        'The plan changed since it was reviewed. Run the review again.'
      )
    case 'artifact_unavailable':
      return translate(
        'auto.components.auditedWorkflow.errors.planApprovalArtifactUnavailable',
        'The plan could not be loaded.'
      )
  }
}

export function getPlanRevisionErrorMessage(reasonCode: PlanRevisionReasonCode): string {
  switch (reasonCode) {
    case 'illegal_transition':
      return translate(
        'auto.components.auditedWorkflow.errors.planRevisionIllegalTransition',
        'This plan cannot be revised right now.'
      )
    case 'lock_contended':
      return translate(
        'auto.components.auditedWorkflow.errors.planRevisionLockContended',
        'Something else changed this task. Refresh and try again.'
      )
    case 'round_limit_reached':
      return translate(
        'auto.components.auditedWorkflow.errors.planRevisionRoundLimit',
        'The revision limit has been reached.'
      )
    case 'worktree_not_verified':
      return translate(
        'auto.components.auditedWorkflow.errors.planRevisionWorktreeNotVerified',
        'The worktree could not be verified, so the revision was not started.'
      )
    case 'prompt_unavailable':
      return translate(
        'auto.components.auditedWorkflow.errors.planRevisionPromptUnavailable',
        'No triage result is available for this task. Run triage first.'
      )
  }
}

/** Mirrors the server-side authority; only controls what is drawn. */
export function isRetryablePlanReviewCode(reasonCode: PlanReviewReasonCode): boolean {
  return isRetryablePlanReviewReasonCode(reasonCode)
}
