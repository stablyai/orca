// Reason code -> human message for the Phase 7 code-audit lane.
//
// Never renders a raw exception, path, argv, tree OID, or agent output: every arm
// returns a written sentence. A `switch` with NO default and no fallback return,
// so lint:switch-exhaustiveness fails the build if CODE_AUDIT_REASON_CODES gains
// a member — a new code must be given a message deliberately, not fall through to
// something generic.
import { translate } from '@/i18n/i18n'
import {
  isRetryableCodeAuditReasonCode,
  type CodeAuditReasonCode
} from '../../../../shared/audited-code-audit-types'

export function getCodeAuditErrorMessage(reasonCode: CodeAuditReasonCode): string {
  switch (reasonCode) {
    case 'illegal_transition':
      return translate(
        'auto.components.auditedWorkflow.errors.codeAuditIllegalTransition',
        'This task is no longer awaiting a code audit.'
      )
    case 'lock_contended':
      return translate(
        'auto.components.auditedWorkflow.errors.codeAuditLockContended',
        'Another action changed this task first. Try again.'
      )
    case 'worktree_not_verified':
      return translate(
        'auto.components.auditedWorkflow.errors.codeAuditWorktreeNotVerified',
        'The audited worktree could not be verified, so the audit did not start.'
      )
    case 'worktree_identity_changed':
      return translate(
        'auto.components.auditedWorkflow.errors.codeAuditWorktreeIdentityChanged',
        'The worktree changed while the audit was starting. Try again.'
      )
    case 'candidate_unavailable':
      return translate(
        'auto.components.auditedWorkflow.errors.candidateUnavailable',
        'There is no reviewable change set for this task yet.'
      )
    case 'candidate_superseded':
      return translate(
        'auto.components.auditedWorkflow.errors.candidateSuperseded',
        'A newer change set replaced the one this audit reviewed.'
      )
    case 'candidate_drift':
      // The single most important message in this lane: it explains a discarded
      // verdict without implying the audit itself misbehaved.
      return translate(
        'auto.components.auditedWorkflow.errors.candidateDrift',
        'The working tree changed during the audit, so its result no longer describes the current code. Run the audit again.'
      )
    case 'task_state_changed':
      return translate(
        'auto.components.auditedWorkflow.errors.codeAuditTaskStateChanged',
        'The task moved on while the audit was running, so its result was discarded.'
      )
    case 'execution_in_progress':
      return translate(
        'auto.components.auditedWorkflow.errors.executionInProgress',
        'A code change is still running. The audit can start once it finishes.'
      )
    case 'code_audit_in_progress':
      return translate(
        'auto.components.auditedWorkflow.errors.codeAuditInProgress',
        'A code audit is already running for this task.'
      )
    case 'round_limit_reached':
      return translate(
        'auto.components.auditedWorkflow.errors.codeAuditRoundLimit',
        'The fix limit has been reached.'
      )
    // Phase 8 §0.2: refused BEFORE spawning Codex, because a candidate that
    // cannot be stored could never be committed later. Names the remedy rather
    // than the internal limit that was hit.
    case 'candidate_store_quota_exceeded':
      return translate(
        'auto.components.auditedWorkflow.errors.codeAuditStoreQuota',
        'This change set is too large to review and store. Reduce its size, or finish another audited task to free space.'
      )
    case 'empty_change_set':
      return translate(
        'auto.components.auditedWorkflow.errors.emptyChangeSet',
        'The run produced no file changes, so there is nothing to audit.'
      )
    case 'candidate_derivation_failed':
      return translate(
        'auto.components.auditedWorkflow.errors.candidateDerivationFailed',
        'The change set could not be computed.'
      )
    case 'candidate_host_unsupported':
      return translate(
        'auto.components.auditedWorkflow.errors.candidateHostUnsupported',
        'Audited code review currently runs only on a local worktree, not over WSL or SSH.'
      )
    case 'candidate_path_unsupported':
      return translate(
        'auto.components.auditedWorkflow.errors.candidatePathUnsupported',
        'This repository’s layout is not supported by the audited code review.'
      )
    case 'provider_not_configured':
      return translate(
        'auto.components.auditedWorkflow.errors.codeAuditProviderNotConfigured',
        'The reviewer is not configured. Add an API key to run code audits.'
      )
    case 'provider_settings_invalid':
      return translate(
        'auto.components.auditedWorkflow.errors.codeAuditProviderSettingsInvalid',
        'The reviewer configuration is unusable and needs to be corrected.'
      )
    case 'credential_delivery_unavailable':
      return translate(
        'auto.components.auditedWorkflow.errors.codeAuditCredentialUnavailable',
        'Orca is not delivering the configured reviewer credential, so the audit did not start.'
      )
    case 'provider_storage_unavailable':
      return translate(
        'auto.components.auditedWorkflow.errors.codeAuditProviderStorageUnavailable',
        'Orca could not read the stored reviewer settings. Try again.'
      )
    case 'launch_plan_invalid':
      return translate(
        'auto.components.auditedWorkflow.errors.codeAuditLaunchPlanInvalid',
        'The reviewer could not be started safely, so it was not started at all.'
      )
    case 'codex_not_found':
      return translate(
        'auto.components.auditedWorkflow.errors.codeAuditCodexNotFound',
        'The Codex CLI could not be found.'
      )
    case 'spawn_failed':
      return translate(
        'auto.components.auditedWorkflow.errors.codeAuditSpawnFailed',
        'The reviewer process could not be started.'
      )
    case 'exit_nonzero':
      return translate(
        'auto.components.auditedWorkflow.errors.codeAuditExitNonzero',
        'The reviewer exited with an error.'
      )
    case 'empty_output':
      return translate(
        'auto.components.auditedWorkflow.errors.codeAuditEmptyOutput',
        'The reviewer produced no output.'
      )
    case 'output_too_large':
      return translate(
        'auto.components.auditedWorkflow.errors.codeAuditOutputTooLarge',
        'The reviewer produced too much output to process.'
      )
    case 'timeout':
      return translate(
        'auto.components.auditedWorkflow.errors.codeAuditTimeout',
        'The reviewer timed out.'
      )
    case 'cancelled_by_user':
      return translate(
        'auto.components.auditedWorkflow.errors.codeAuditCancelled',
        'The audit was cancelled.'
      )
    case 'interrupted':
      return translate(
        'auto.components.auditedWorkflow.errors.codeAuditInterrupted',
        'The audit was interrupted before it finished.'
      )
    case 'verdict_unparseable':
      return translate(
        'auto.components.auditedWorkflow.errors.codeAuditVerdictUnparseable',
        'The reviewer’s answer could not be read, so no verdict was recorded.'
      )
    case 'unexpected_commit_detected':
      return translate(
        'auto.components.auditedWorkflow.errors.codeAuditUnexpectedCommit',
        'The repository changed unexpectedly during the audit, so the result was refused.'
      )
  }
}

/**
 * Whether Retry is drawn. Delegates to the SHARED authority so the button and the
 * server cannot disagree — this only controls what is drawn, never what is legal.
 */
export function isRetryableCodeAuditCode(code: CodeAuditReasonCode): boolean {
  return isRetryableCodeAuditReasonCode(code)
}
