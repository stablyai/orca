import { z } from 'zod'
import { SSH_RUNTIME_DURATION_BUCKETS } from './telemetry-ssh-runtime-event-schemas'

// Why enum-only: these rows size how WSL moves end. A distro, repo or path name, a migration
// id or a raw error would identify a machine, so none may appear; unknown codes become `other`.

/** A refusal's code without its `wsl_move_` prefix. */
export const WSL_MOVE_REFUSAL_VALUES = [
  'none',
  'unavailable',
  'already_running',
  'already_in_flight',
  'nothing_new',
  'host_unavailable',
  'host_update_required',
  'terminals_blocked',
  'export_incomplete',
  'manifest_too_large',
  'pause_failed',
  'scope_changed',
  'cancelled',
  'finished_earlier_move',
  'other'
] as const

/** The last move phase the desktop journaled before it was reset or left waiting. */
export const WSL_MOVE_PHASE_VALUES = [
  'none',
  'before_stage',
  'destination_staged',
  'blobs_transferred',
  'destination_committed'
] as const

/** Why a move was put back to zero, or is waiting for its host. */
export const WSL_MOVE_RESET_REASON_VALUES = [
  'none',
  'staged_claim_conflict',
  'repository_path_conflict',
  'host_unreachable',
  'distro_unregistered',
  'stage_rejected',
  'blob_rejected',
  'commit_rejected',
  'terminals_started',
  'exit_unverifiable',
  'other'
] as const

export const WSL_MOVE_BYTES_BUCKETS = [
  '0',
  'lt_1mb',
  '1mb_10mb',
  '10mb_100mb',
  'gte_100mb'
] as const

// `started` counts attempts (it precedes refusals too) and carries placeholder buckets.
export const wslMoveSchema = z
  .object({
    outcome: z.enum(['started', 'finished', 'reset', 'refused', 'waiting_for_host']),
    refusal: z.enum(WSL_MOVE_REFUSAL_VALUES),
    phase: z.enum(WSL_MOVE_PHASE_VALUES),
    reset_reason: z.enum(WSL_MOVE_RESET_REASON_VALUES),
    duration_bucket: z.enum(SSH_RUNTIME_DURATION_BUCKETS),
    // Scrollback, shell history and restore hints sent: what the move had to carry.
    bytes_bucket: z.enum(WSL_MOVE_BYTES_BUCKETS)
  })
  .strict()

/** What woke the move orchestrator (D3a) for a distro; `timer` is a retry or deferred re-check. */
export const WSL_MOVE_ORCHESTRATOR_TRIGGER_VALUES = [
  'connect',
  'project_opened',
  'startup',
  'user',
  'timer'
] as const

/** The state the orchestrator left the distro in; reported only when it changes. */
export const WSL_MOVE_ORCHESTRATOR_TRANSITION_VALUES = [
  'idle',
  'pending',
  'deferred',
  'started',
  'waiting_for_host',
  'backoff',
  'parked',
  'done',
  'distro_gone',
  'restore_offered'
] as const

export const WSL_MOVE_ORCHESTRATOR_PARK_REASON_VALUES = [
  'none',
  'export_incomplete',
  'manifest_too_large',
  'host_update_required',
  'attempts_exhausted',
  'not_now',
  'declined',
  'removal_pending',
  'stuck'
] as const

export const WSL_MOVE_ORCHESTRATOR_ATTEMPT_BUCKETS = ['0', '1', '2_3', 'gte_4'] as const

// Same enum-only rule as `wsl_move`: no distro, project or migration id leaves.
export const wslMoveOrchestratorSchema = z
  .object({
    trigger: z.enum(WSL_MOVE_ORCHESTRATOR_TRIGGER_VALUES),
    transition: z.enum(WSL_MOVE_ORCHESTRATOR_TRANSITION_VALUES),
    refusal: z.enum(WSL_MOVE_REFUSAL_VALUES),
    reset_reason: z.enum(WSL_MOVE_RESET_REASON_VALUES),
    park_reason: z.enum(WSL_MOVE_ORCHESTRATOR_PARK_REASON_VALUES),
    attempt_bucket: z.enum(WSL_MOVE_ORCHESTRATOR_ATTEMPT_BUCKETS)
  })
  .strict()
