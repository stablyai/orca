// Closed vocabularies for Phase 4 audited execution runs. Separate from
// audited-workflow-types.ts for the same reason audited-worktree-types.ts is:
// widening TriageReasonCode would silently break the renderer's exhaustive
// switches (lint:switch-exhaustiveness).
import type { AuditedTaskState } from './audited-workflow-types'

export const EXECUTION_MODES = ['plan', 'direct'] as const
export type ExecutionMode = (typeof EXECUTION_MODES)[number]

// `running` is the only non-terminal status. `blocked` is distinct from
// `failed`: it records a run whose work may have completed but whose worktree
// verification refused to advance the task (drift), which is never retryable.
export const EXECUTION_RUN_STATUSES = [
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'interrupted',
  'blocked'
] as const
export type ExecutionRunStatus = (typeof EXECUTION_RUN_STATUSES)[number]

// Failures only — success is the `ok: true` arm of a discriminated result.
export const EXECUTION_REASON_CODES = [
  'illegal_transition',
  'lock_contended',
  'worktree_not_verified',
  'prompt_unavailable',
  'claude_not_found',
  'spawn_failed',
  'exit_nonzero',
  'empty_output',
  'output_too_large',
  'timeout',
  'cancelled_by_user',
  'interrupted',
  'unexpected_commit_detected',
  'unsupported_host'
] as const
export type ExecutionReasonCode = (typeof EXECUTION_REASON_CODES)[number]

// The server-side authority for whether Retry is admissible. Enforced in
// audited-execution-run-retry.ts, NOT the renderer — the renderer helper only
// decides whether a button is drawn.
//
// Deliberately absent: `unexpected_commit_detected` (the worktree carries a
// commit Phase 4 cannot undo), `output_too_large` (a rerun produces the same
// flood), `cancelled_by_user` (not a failure), and the admission codes
// `illegal_transition` / `lock_contended` / `worktree_not_verified` /
// `prompt_unavailable`, none of which ever reached a spawn.
export const RETRYABLE_EXECUTION_REASON_CODES: readonly ExecutionReasonCode[] = [
  'exit_nonzero',
  'timeout',
  'interrupted',
  'spawn_failed',
  'claude_not_found',
  'empty_output'
]

export function isRetryableExecutionReasonCode(code: ExecutionReasonCode): boolean {
  return RETRYABLE_EXECUTION_REASON_CODES.includes(code)
}

// The state a run's task held BEFORE its start transition. Cancel restores
// exactly this, so a direct run never strands in `implementing`.
export const EXECUTION_PRE_LAUNCH_STATES: readonly AuditedTaskState[] = [
  'planning',
  'ready_to_implement'
]

// The state a run LIVES in. Distinct from pre_launch_state for direct runs;
// this is the value written to pre_block_state on failure.
export const EXECUTION_ACTIVE_RUN_STATES: readonly AuditedTaskState[] = ['planning', 'implementing']
