// Renderer-facing param/return contract for the orchestration preload binding
// (`window.api.orchestration.*`). Mirrors the shapes the already-registered RPC
// methods define in src/main/runtime/rpc/methods/orchestration{,-gates}.ts so the
// renderer can start a coordinator run (or create a task) over the same runtime
// channel the CLI uses. Kept in `shared` because preload, renderer, and any
// future client need one contract without importing main internals across the
// process/layer boundary (preload never depends on main).

/** RPC method names this binding forwards to — kept as constants so the preload
 *  implementations and tests reference one source of truth, not stringly-typed
 *  literals that can drift from the registered method names. */
export const ORCHESTRATION_RUN_RPC_METHOD = 'orchestration.run'
export const ORCHESTRATION_TASK_CREATE_RPC_METHOD = 'orchestration.taskCreate'

/** Lifecycle status of a coordinator run. Mirrors CoordinatorStatus in
 *  src/main/runtime/orchestration/types.ts. */
export type OrchestrationCoordinatorStatus = 'idle' | 'running' | 'completed' | 'failed'

/** Lifecycle status of a task. Mirrors TaskStatus in the orchestration types. */
export type OrchestrationTaskStatus =
  | 'pending'
  | 'ready'
  | 'dispatched'
  | 'completed'
  | 'failed'
  | 'blocked'

/** A persisted orchestration task row as returned by orchestration.taskCreate.
 *  Mirrors TaskRow in src/main/runtime/orchestration/types.ts; the RPC boundary
 *  serializes to JSON, so the snake_case DB column names are preserved as-is. */
export type OrchestrationTask = {
  id: string
  parent_id: string | null
  created_by_terminal_handle: string | null
  coordinator_run_id: string | null
  target_key: string | null
  task_title: string | null
  display_name: string | null
  spec: string
  status: OrchestrationTaskStatus
  deps: string
  result: string | null
  created_at: string
  completed_at: string | null
}

/** Params for orchestration.run. Field names match the RPC Zod schema (RunParams)
 *  so they pass straight through unchanged. `worktree`/target-key handling (F1)
 *  and `worktreeBacked`/`workerAgent` (F2 slice 1) are forwarded verbatim — the
 *  semantics live in the main handler, not here. */
export type OrchestrationRunParams = {
  spec: string
  from?: string
  pollIntervalMs?: number
  maxConcurrent?: number
  worktree?: string
  worktreeBacked?: boolean
  workerAgent?: string
}

/** Result of orchestration.run. The run starts in the background and is polled
 *  via orchestration.taskList; `status` is 'running' on a successful start and is
 *  typed to the run-status union for forward compatibility. */
export type OrchestrationRunResult = {
  runId: string
  status: OrchestrationCoordinatorStatus
}

/** Params for orchestration.taskCreate. Field names match the RPC Zod schema
 *  (TaskCreateParams). `deps` is a JSON-encoded array of task IDs (the handler
 *  parses it); `callerTerminalHandle` stamps the task's own target so adoption
 *  binds it only to a same-target run. */
export type OrchestrationTaskCreateParams = {
  spec: string
  taskTitle?: string
  displayName?: string
  deps?: string
  parent?: string
  callerTerminalHandle?: string
}

/** Result of orchestration.taskCreate. */
export type OrchestrationTaskCreateResult = {
  task: OrchestrationTask
}

/** The renderer-facing orchestration namespace exposed at
 *  `window.api.orchestration`. Additive plumbing — nothing in the UI calls it yet
 *  (the recipe backend, #9, is the first consumer). */
export type OrchestrationPreloadApi = {
  run: (params: OrchestrationRunParams) => Promise<OrchestrationRunResult>
  taskCreate: (params: OrchestrationTaskCreateParams) => Promise<OrchestrationTaskCreateResult>
}
