// The orchestration workers a native chat started, as its composer tray and side panel draw them.

export const ORCHESTRATION_SESSION_WORKERS_METHOD = 'orchestration.sessionWorkers'

/** A result line is a glance, not the report; the full text stays in `worker-show`. */
export const ORCHESTRATION_SESSION_WORKER_SUMMARY_MAX = 280

/** How far a chat reads back; older workers stay in `orca orchestration worker-list`. */
export const ORCHESTRATION_SESSION_WORKERS_LIMIT = 50

/** The Dispatch's lifecycle, never the agent's own state: `working` is an open Dispatch whose
 *  process is live, even while its agent waits. `stopped` covers a worker that exited without reporting and,
 *  where only shown, one whose terminal its host can't find at all (its Dispatch may still be open). */
export type OrchestrationSessionWorkerState =
  | 'working'
  | 'completed'
  | 'failed'
  | 'stopped'
  | 'unverifiable'

export type OrchestrationSessionWorker = {
  dispatchId: string
  taskId: string
  runId: string
  /** The Task's title, else its display name, else its id. */
  title: string
  /** The agent the worker runs, e.g. `claude` or `codex`; null when the host never named one. */
  agent: string | null
  state: OrchestrationSessionWorkerState
  /** The agent's own reported state while its process is live; `unknown` without a fresh report.
   *  Absent from older hosts. */
  activity?: OrchestrationSessionWorkerActivity
  /** Its turn ended while its own background tasks still run: since when, and what they run. Absent
   *  otherwise and from older hosts. */
  backgroundWait?: { since: number; commands: string[] }
  /** The worker asked its coordinator, or awaits its decision, and has no answer yet. Absent from older hosts. */
  pendingQuestion?: boolean
  /** The execution host's own verdict; contact loss is never read as an exit. */
  liveness: 'live' | 'unverifiable' | 'exited'
  /** Where the worker runs, relative to the host that answered. */
  host: 'local' | 'remote'
  /** The paired server a remote worker runs on, as the answering host names it. Absent from older hosts. */
  hostEnvironmentId?: string
  worktreeId: string | null
  /** The mailbox address the worker sends from (its terminal or chat handle), so a chat can tell which
   *  Dispatch a piece of mail came from. Absent from older hosts. */
  address?: string | null
  /** The worker's terminal pane, when it runs in a terminal. */
  paneKey: string | null
  /** The worker's chat session, when it runs in a native chat. */
  chatSessionId: string | null
  /** The Task's recorded result, clipped; absent from older hosts. */
  summary?: string | null
  /** Passive live status recorded via `orchestration task-update --note`; absent when unset or on older hosts. */
  progressNote?: string | null
  progressUpdatedAt?: number | null
  /** Epoch ms the Dispatch started. */
  startedAt: number
  /** Epoch ms the Dispatch settled; null while it runs. */
  settledAt: number | null
}

export type OrchestrationSessionWorkersResult = {
  workers: OrchestrationSessionWorker[]
  /** The host announces each worker a session starts or settles (orchestrationSessionWorkersChanged);
   *  absent on older hosts, whose readers re-read on each new transcript row instead. */
  workerNotices?: true
}

export type OrchestrationSessionWorkerActivity =
  | 'working'
  | 'blocked'
  | 'waiting'
  | 'done'
  | 'unknown'

/** Its Dispatch is still open, or out of contact and so possibly still open; its agent may be idle. */
export function sessionWorkerIsRunning(worker: Pick<OrchestrationSessionWorker, 'state'>): boolean {
  return worker.state === 'working' || worker.state === 'unverifiable'
}

/** Its start failed before an agent ran, so it has nothing to open. Only a local worker: a paired
 *  server's worker loses its terminal handle when released, though it ran. */
export function sessionWorkerNeverStarted(
  worker: Pick<OrchestrationSessionWorker, 'state' | 'address' | 'host'>
): boolean {
  return worker.state === 'failed' && !worker.address && worker.host === 'local'
}

/** The agent state an open worker draws: its own report (working without one, as from an older host),
 *  resting while its open `ask` or gate waits on its coordinator. A prompt it reports still shows. */
export function sessionWorkerAgentState(
  worker: Pick<OrchestrationSessionWorker, 'activity' | 'pendingQuestion' | 'backgroundWait'>
): Exclude<OrchestrationSessionWorkerActivity, 'unknown'> {
  // Its own turn is over: it waits on its background tasks, not working.
  if (worker.backgroundWait) {
    return 'done'
  }
  const reported = worker.activity && worker.activity !== 'unknown' ? worker.activity : 'working'
  return reported === 'working' && worker.pendingQuestion ? 'done' : reported
}

/** A live worker resting on its open `ask`, with no prompt of its own. A gate can't open while its
 *  task's worker runs, so a live worker's open question is always an ask. */
export function sessionWorkerAsksCoordinator(
  worker: Pick<
    OrchestrationSessionWorker,
    'state' | 'activity' | 'pendingQuestion' | 'backgroundWait'
  >
): boolean {
  return worker.state === 'working' && sessionWorkerRestsOnAsk(worker)
}

/** Its open question waits on its coordinator and it reports no prompt of its own. */
export function sessionWorkerRestsOnAsk(
  worker: Pick<OrchestrationSessionWorker, 'activity' | 'pendingQuestion' | 'backgroundWait'>
): boolean {
  return Boolean(worker.pendingQuestion) && sessionWorkerAgentState(worker) === 'done'
}

/** Mid-turn: live, with no open question, and its agent has not reported stopping to wait. */
export function sessionWorkerIsWorking(
  worker: Pick<
    OrchestrationSessionWorker,
    'state' | 'activity' | 'pendingQuestion' | 'backgroundWait'
  >
): boolean {
  return worker.state === 'working' && sessionWorkerAgentState(worker) === 'working'
}
