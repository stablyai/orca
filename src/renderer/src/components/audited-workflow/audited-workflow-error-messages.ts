// Maps closed reason codes to localized, user-safe messages. This is the
// ONLY place select-task/list-load failures become renderer-visible text —
// never a raw exception message, path, command string, or Git stderr. See
// plan §10.2/§10.3 (privacy boundaries) and ipc/audited-workflow.ts (where
// the reason codes are produced instead of thrown raw errors).
import { translate } from '@/i18n/i18n'
import type {
  SelectTaskReasonCode,
  TriageReasonCode
} from '../../../../shared/audited-workflow-types'
import {
  isRetryableProvisioningReasonCode,
  type WorktreeReasonCode
} from '../../../../shared/audited-worktree-types'

export function getSelectTaskErrorMessage(reasonCode: SelectTaskReasonCode): string {
  switch (reasonCode) {
    case 'repo_not_found':
      return translate(
        'auto.components.auditedWorkflow.errors.repoNotFound',
        'That repository could not be found. Refresh and try again.'
      )
    case 'unsupported_host':
      return translate(
        'auto.components.auditedWorkflow.errors.unsupportedHost',
        'Audited Workflow currently supports local Git repositories only.'
      )
    case 'git_resolution_failed':
      return translate(
        'auto.components.auditedWorkflow.errors.gitResolutionFailed',
        'Could not read the repository. Make sure it is a valid Git repository and try again.'
      )
    case 'internal_error':
      return translate(
        'auto.components.auditedWorkflow.errors.internalError',
        'Something went wrong creating the task. Please try again.'
      )
  }
}

export function getTaskListErrorMessage(): string {
  return translate(
    'auto.components.auditedWorkflow.errors.listLoadFailed',
    'Could not load audited tasks.'
  )
}

export function getStartTriageErrorMessage(reasonCode: TriageReasonCode): string {
  switch (reasonCode) {
    case 'illegal_transition':
      return translate(
        'auto.components.auditedWorkflow.errors.triageIllegalTransition',
        'Triage cannot be started for this task right now.'
      )
    case 'lock_contended':
      return translate(
        'auto.components.auditedWorkflow.errors.triageLockContended',
        'Triage is already running for this task.'
      )
    case 'provider_unavailable':
      return translate(
        'auto.components.auditedWorkflow.errors.triageProviderUnavailable',
        'Triage is not configured. Add an OpenAI API key to use this feature.'
      )
    case 'provider_timeout':
      return translate(
        'auto.components.auditedWorkflow.errors.triageProviderTimeout',
        'Triage timed out. You can retry.'
      )
    case 'provider_error':
      return translate(
        'auto.components.auditedWorkflow.errors.triageProviderError',
        'Triage failed unexpectedly. You can retry.'
      )
    case 'output_invalid':
      return translate(
        'auto.components.auditedWorkflow.errors.triageOutputInvalid',
        'Triage returned an invalid result. You can retry.'
      )
    case 'interrupted':
      return translate(
        'auto.components.auditedWorkflow.errors.triageInterrupted',
        'Triage was interrupted before it finished. You can retry.'
      )
  }
}

// Why: only these reason codes are safe to offer an immediate retry for —
// illegal_transition means the task moved on (retry would just re-fail), so
// it is excluded even though the button text otherwise doesn't distinguish.
export function isRetryableTriageReasonCode(reasonCode: TriageReasonCode): boolean {
  return reasonCode !== 'illegal_transition' && reasonCode !== 'lock_contended'
}

/**
 * Whether to draw a Retry button for a worktree failure. Retry is safe ONLY for
 * provisioning failures the main process persists exclusively when Git provably
 * made no durable change — a failure that left partial evidence is recorded as
 * provision_evidence_ambiguous instead, which is never retryable.
 *
 * This mirrors the server-side admission rules in audited-worktree-recovery.ts;
 * the button only controls what is drawn, never enforcement.
 */
export function isRetryableWorktreeReasonCode(reasonCode: WorktreeReasonCode): boolean {
  return isRetryableProvisioningReasonCode(reasonCode)
}

/** Legacy tasks that never got a worktree get an explicit provisioning action. */
export function needsExplicitWorktreeProvisioning(reasonCode: WorktreeReasonCode): boolean {
  return reasonCode === 'worktree_never_provisioned'
}
