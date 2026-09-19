/**
 * Worker terminal process accounting, canonical for the DB derivation and the wire.
 *
 * Never a Task/Dispatch outcome: these say what happened to the worker's *terminal*, so a
 * succeeded worker can still hold a `retained` process. Declared in `shared` because
 * `serve.stats` publishes a per-state histogram and `src/shared` cannot import from `src/main`.
 * The main-side alias is `WorkerTerminalListState`
 * (src/main/runtime/orchestration/worker-terminal-ownership.ts) and the fleet projection reads it
 * as `FleetTerminalState`; all three are the same six values by construction.
 */
export const WORKER_TERMINAL_LIST_STATES = [
  'active',
  'reclaimable',
  'retained',
  'release_pending',
  'release_unknown',
  'released'
] as const

export type WorkerTerminalListState = (typeof WORKER_TERMINAL_LIST_STATES)[number]
