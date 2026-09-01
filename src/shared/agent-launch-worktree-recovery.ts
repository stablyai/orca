// Client-safe recovery contracts for a worktree's settled agent-launch failure
// (U4): the retry action a recovery card can request and the tri-state result
// arms the renderer reconciles. These cross the local IPC and runtime RPC
// boundary, so they carry only codes, receipts, and persisted failures — never
// argv/env/paths/labels. Host orchestration lives in
// src/main/agent-launch/agent-launch-worktree-{retry,forget}.ts, which re-export
// these so renderer, preload, and host all type-check against one definition.

import type { TuiAgent } from './types'
import type {
  AgentLaunchFailure,
  AgentLaunchReceipt,
  AgentLaunchRequestError,
  PersistedAgentLaunchFailure
} from './agent-launch-contract'

/** A recovery card can retry the pinned identity unchanged or adopt a live
 *  agent selection. change-agent carries no source record, so it never gains
 *  tombstone/safe-fallback authority (that is host-enforced on resolution). */
export type RetryAgentLaunchAction =
  | { kind: 'retry-same' }
  | { kind: 'change-agent'; agent: TuiAgent }

/** Tri-state (plus rejected) retry outcome:
 *  - launched: the primary agent spawned; clear the recovery card;
 *  - failed: a new durable attempt failure (mutation) whose failureId the card
 *    retries against next;
 *  - blocked: nothing ran and nothing changed (recovery-gate state or a
 *    deterministic pre-launch rejection) — keep the current card, show why;
 *  - rejected: benign protocol outcome (idempotency_conflict / stale) — refresh. */
export type WorktreeRetryAgentLaunchResult =
  | { status: 'launched'; receipt: AgentLaunchReceipt }
  | { status: 'failed'; failure: PersistedAgentLaunchFailure }
  | { status: 'blocked'; failure: AgentLaunchFailure }
  | { status: 'rejected'; requestError: AgentLaunchRequestError }

/** Forget releases Orca's local bookkeeping for a launch stranded in
 *  launch_state_unknown; it never kills or spawns. rejected covers the benign
 *  idempotency/stale protocol outcomes. */
export type ForgetUnknownAgentLaunchResult =
  | { status: 'forgotten' }
  | { status: 'rejected'; requestError: AgentLaunchRequestError }
