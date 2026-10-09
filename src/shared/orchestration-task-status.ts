/**
 * The orchestration task lifecycle statuses, canonical for both the DB layer and the wire.
 *
 * Declared in `shared` because `serve.stats` publishes a per-status histogram and `src/shared`
 * cannot import from `src/main`: a second copy of this union would let the published contract
 * silently omit a status the DB can already hold. The main-side alias is `TaskStatus`
 * (src/main/runtime/orchestration/types.ts).
 */
export const ORCHESTRATION_TASK_STATUSES = [
  'pending',
  'ready',
  'dispatched',
  'completed',
  'failed',
  'blocked'
] as const

export type OrchestrationTaskStatus = (typeof ORCHESTRATION_TASK_STATUSES)[number]
