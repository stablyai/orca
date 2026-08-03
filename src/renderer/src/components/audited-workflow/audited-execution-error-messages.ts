// Maps closed execution reason codes to localized, user-safe messages. Never a
// raw exception message, path, argv, or agent output — the main process
// produces closed codes precisely so none of that can reach here.
//
// Exhaustive switch with no `default`, so lint:switch-exhaustiveness fails on an
// unmapped addition rather than letting one silently fall through.
import { translate } from '@/i18n/i18n'
import {
  isRetryableExecutionReasonCode,
  type ExecutionReasonCode
} from '../../../../shared/audited-execution-types'
import type { WorktreeReasonCode } from '../../../../shared/audited-worktree-types'
import { getWorktreeErrorMessage } from './audited-worktree-error-messages'

export function getExecutionErrorMessage(reasonCode: ExecutionReasonCode): string {
  switch (reasonCode) {
    case 'illegal_transition':
      return translate(
        'auto.components.auditedWorkflow.errors.executionIllegalTransition',
        'This task cannot run right now.'
      )
    case 'lock_contended':
      return translate(
        'auto.components.auditedWorkflow.errors.executionLockContended',
        'A run is already in progress for this task.'
      )
    case 'worktree_not_verified':
      return translate(
        'auto.components.auditedWorkflow.errors.executionWorktreeNotVerified',
        'The worktree could not be verified, so nothing was started.'
      )
    case 'prompt_unavailable':
      return translate(
        'auto.components.auditedWorkflow.errors.executionPromptUnavailable',
        'No triage result is available for this task yet. Run triage first.'
      )
    case 'claude_not_found':
      return translate(
        'auto.components.auditedWorkflow.errors.executionClaudeNotFound',
        'Claude Code was not found on your PATH. Install it, then retry.'
      )
    case 'spawn_failed':
      return translate(
        'auto.components.auditedWorkflow.errors.executionSpawnFailed',
        'Claude Code could not be started. You can retry.'
      )
    case 'exit_nonzero':
      return translate(
        'auto.components.auditedWorkflow.errors.executionExitNonzero',
        'Claude Code exited with an error. You can retry.'
      )
    case 'empty_output':
      return translate(
        'auto.components.auditedWorkflow.errors.executionEmptyOutput',
        'The run finished without producing a plan. You can retry.'
      )
    case 'output_too_large':
      return translate(
        'auto.components.auditedWorkflow.errors.executionOutputTooLarge',
        'The run produced too much output and was stopped.'
      )
    case 'timeout':
      return translate(
        'auto.components.auditedWorkflow.errors.executionTimeout',
        'The run timed out and was stopped. You can retry.'
      )
    case 'cancelled_by_user':
      return translate(
        'auto.components.auditedWorkflow.errors.executionCancelled',
        'The run was cancelled.'
      )
    case 'interrupted':
      return translate(
        'auto.components.auditedWorkflow.errors.executionInterrupted',
        'The run was interrupted before it finished. You can retry.'
      )
    case 'unexpected_commit_detected':
      return translate(
        'auto.components.auditedWorkflow.errors.executionUnexpectedCommit',
        'The worktree changed unexpectedly during the run, so the task was not advanced.'
      )
    case 'unsupported_host':
      return translate(
        'auto.components.auditedWorkflow.errors.executionUnsupportedHost',
        'Audited runs are supported on local Git repositories only.'
      )
  }
}

/** Mirrors the server-side authority; only controls what is drawn. */
export function isRetryableExecutionCode(reasonCode: ExecutionReasonCode): boolean {
  return isRetryableExecutionReasonCode(reasonCode)
}

/**
 * The message for a FAILED RETRY PREFLIGHT. Deliberately states that the task is
 * still blocked and that the fix happens outside Orca — Phase 4 offers no
 * recovery action for this case, because none is admissible (see
 * audited-worktree-recovery.ts's resolveRecoveryAdmission: an execution-blocked
 * task has a null worktree_reason_code and a pre_block_state of
 * planning/implementing, so recovery would refuse it every time).
 *
 * Must never imply Orca will repair the worktree.
 */
export function getRetryPreflightWorktreeMessage(reasonCode: WorktreeReasonCode): string {
  return translate(
    'auto.components.auditedWorkflow.errors.executionRetryPreflightFailed',
    'Worktree verification failed: {reason} The task is still blocked and nothing was changed. Resolve the worktree condition, then retry.'
  ).replace('{reason}', getWorktreeErrorMessage(reasonCode))
}
