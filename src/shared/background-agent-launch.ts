// Client-safe contract for a GENERIC background agent-launch attempt — the
// owner record for unattended launches that have no automation run or
// orchestration dispatch to land in (GitHub work-item background launches,
// worktree-composer background terminals). Keyed by `attemptId` and pointing at
// its worktree so a background failure survives reload and its recovery card
// renders on the worktree, WITHOUT conflating with the interactive two-stage
// `WorktreeMeta.pendingAgentLaunch`/`agentLaunchFailure` (plan §U6: the generic
// attempt store is distinct from the already-created owner records).
//
// The record is created BEFORE resolution and is admission-capped; its state is
// persisted through the shared tri-state reconciler. Every field here is
// client-safe: `attemptId`/`operationId` are anti-race guards (already visible
// in client metadata, never secrets), `worktreeId` is a display/deep-link join,
// `requestedAgent` is display attribution, and `failure` is the code+hint
// contract. The private launch snapshot and token live only in the host
// operation store keyed by launch token — never in this record — so the host
// record and the client DTO are the same shape.

import { z } from 'zod'
import { persistedAgentLaunchFailureSchema } from './agent-launch-failure-schema'
import { isBuiltInTuiAgent, isTuiAgent } from './tui-agent-config'
import type { PersistedAgentLaunchFailure } from './agent-launch-contract'
import type { RetryAgentLaunchAction } from './agent-launch-worktree-recovery'
import type { BuiltInTuiAgent, TuiAgent } from './types'

/** Tri-state disposition a background attempt reconciles through, plus the
 *  owner-authorized Forget terminal. `launch_state_unknown` is NOT a separate
 *  state: it is modeled as `state: 'pending'` coexisting with a failure whose
 *  code is `launch_state_unknown` (the coexistence rule — the reservation and
 *  private snapshot survive until a live/absent proof or an explicit Forget),
 *  exactly as `WorktreeMeta.pendingAgentLaunch` + `agentLaunchFailure` model it. */
export type BackgroundAgentLaunchState = 'pending' | 'launched' | 'failed' | 'forgotten'

export type BackgroundAgentLaunchAttempt = {
  /** Canonical lowercase UUID identifying this attempt (idempotency + deep link). */
  attemptId: string
  /** Worktree this launch targets. Keeps the deep link keyed off the attempt's
   *  worktree, not a possibly-deleted per-run workspace. */
  worktreeId: string
  /** Agent-launch operation id — the reconciler/idempotency join to the private
   *  operation store. Anti-race guard, not a secret. */
  operationId: string
  requestedAgent: TuiAgent
  /** Resolved base harness once known; null before resolution or when a request
   *  error prevented resolution (such attempts never enter history — see plan). */
  baseAgent: BuiltInTuiAgent | null
  state: BackgroundAgentLaunchState
  /** Durable code+hint failure. Present for `failed`, for a `pending` attempt
   *  stranded in `launch_state_unknown`, and retained through `forgotten`. */
  failure: PersistedAgentLaunchFailure | null
  createdAt: number
  updatedAt: number
  /** Set only when an owner explicitly forgot a `launch_state_unknown` attempt. */
  forgottenAt: number | null
}

export const backgroundAgentLaunchStateSchema = z.enum([
  'pending',
  'launched',
  'failed',
  'forgotten'
]) satisfies z.ZodType<BackgroundAgentLaunchState>

/** Strict schema for the persisted/round-tripped attempt. `.strict()` rejects
 *  unknown fields so a corrupt or forged entry drops on read rather than
 *  surfacing a recovery card. */
export const backgroundAgentLaunchAttemptSchema = z
  .object({
    attemptId: z.string().min(1),
    worktreeId: z.string().min(1),
    operationId: z.string().min(1),
    requestedAgent: z.custom<TuiAgent>((v) => isTuiAgent(v)),
    baseAgent: z.custom<BuiltInTuiAgent>((v) => isBuiltInTuiAgent(v)).nullable(),
    state: backgroundAgentLaunchStateSchema,
    failure: persistedAgentLaunchFailureSchema.nullable(),
    createdAt: z.number(),
    updatedAt: z.number(),
    forgottenAt: z.number().nullable()
  })
  .strict() satisfies z.ZodType<BackgroundAgentLaunchAttempt>

/** Parse a stored attempt, or null when malformed / carrying unknown fields.
 *  Used on load so one corrupt row never aborts rehydrating the rest. */
export function parseBackgroundAgentLaunchAttempt(
  value: unknown
): BackgroundAgentLaunchAttempt | null {
  const parsed = backgroundAgentLaunchAttemptSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

/** Owner-authorized retry of a background attempt's failure, guarded by the
 *  attempt id + a client mutation id (same idempotency discipline as
 *  `worktree.retryAgentLaunch`). Reuses the shared recovery action so the
 *  recovery card renders identically to the worktree and session surfaces. */
export type RetryBackgroundAgentLaunchRequest = {
  attemptId: string
  expectedFailureId: string
  clientMutationId: string
  action: RetryAgentLaunchAction
}

/** Owner-authorized Forget of a background attempt stranded in
 *  `launch_state_unknown`. Frees exactly one reservation; never kills/spawns. */
export type ForgetBackgroundAgentLaunchRequest = {
  attemptId: string
  expectedOperationId: string
  clientMutationId: string
}
