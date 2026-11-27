/** Kept open, or temporary with the host's deadline (null while it runs or works again); the host
 *  answers null when nothing closes it. Hosts without orchestration.worker-keep-open.v1 lack the method. */
export type WorkerAutoCloseState =
  | { kept: true }
  | { kept: false; closesAt: string | null; boundTo?: BoundWorker }

/** On a terminal that closes with a worker: that worker, by its pane and the name its record has.
 *  Older hosts omit it. */
export type BoundWorker = {
  paneKey: string
  worktreeId: string | null
  name: string | null
  /** The agent the worker started with, for its icon once its tab is gone. */
  agent: string | null
}

export function readWorkerAutoCloseReply(result: unknown): WorkerAutoCloseState | null {
  if (typeof result !== 'object' || result === null || !('autoClose' in result)) {
    return null
  }
  const state = result.autoClose
  if (typeof state !== 'object' || state === null || !('kept' in state)) {
    return null
  }
  if (state.kept === true) {
    return { kept: true }
  }
  const closesAt = 'closesAt' in state ? state.closesAt : null
  const boundTo = 'boundTo' in state ? readBoundWorker(state.boundTo) : null
  return {
    kept: false,
    closesAt: typeof closesAt === 'string' ? closesAt : null,
    ...(boundTo ? { boundTo } : {})
  }
}

function readBoundWorker(value: unknown): BoundWorker | null {
  if (typeof value !== 'object' || value === null || !('paneKey' in value)) {
    return null
  }
  const { paneKey } = value
  const worktreeId = 'worktreeId' in value ? value.worktreeId : null
  const name = 'name' in value ? value.name : null
  const agent = 'agent' in value ? value.agent : null
  return typeof paneKey === 'string'
    ? {
        paneKey,
        worktreeId: typeof worktreeId === 'string' ? worktreeId : null,
        name: typeof name === 'string' ? name : null,
        agent: typeof agent === 'string' ? agent : null
      }
    : null
}

/** How long after a temporary worker finishes its host closes it; the banner's copy and progress follow it. */
export const WORKER_AUTO_CLOSE_GRACE_MS = 2 * 60_000

/** m:ss until the host's deadline, never below 0:00. */
export function formatWorkerAutoCloseCountdown(closesAt: string, nowMs: number): string {
  const seconds = Math.max(0, Math.ceil((Date.parse(closesAt) - nowMs) / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

// A temporary worker is re-read to follow its finish and follow-ups; its countdown ticks locally. Kept,
// unanswered and not-yet-temporary states are re-read rarely, so another client's change or a turned-on setting shows.
const TEMPORARY_POLL_MS = 15_000
const SETTLED_POLL_MS = 60_000

/** Reads now and again until the returned stop is called. */
export function pollWorkerAutoClose(
  read: () => Promise<WorkerAutoCloseState | null>,
  onState: (state: WorkerAutoCloseState | null) => void
): () => void {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const poll = (): void => {
    void read().then((state) => {
      if (!stopped) {
        onState(state)
        timer = setTimeout(poll, state && !state.kept ? TEMPORARY_POLL_MS : SETTLED_POLL_MS)
      }
    })
  }
  poll()
  return () => {
    stopped = true
    clearTimeout(timer)
  }
}

// One state per worker for every surface showing it, so a reply from the tab menu reaches the strip.
const published = new Map<string, WorkerAutoCloseState | null>()
const listeners = new Map<string, Set<() => void>>()

export function publishWorkerAutoClose(key: string, state: WorkerAutoCloseState | null): void {
  const subscribed = listeners.get(key)
  if (subscribed) {
    published.set(key, state)
    subscribed.forEach((listener) => listener())
  }
}

export function readPublishedWorkerAutoClose(key: string | null): WorkerAutoCloseState | null {
  return key === null ? null : (published.get(key) ?? null)
}

export function subscribeWorkerAutoClose(key: string | null, listener: () => void): () => void {
  if (key === null) {
    return () => {}
  }
  const subscribed = listeners.get(key) ?? new Set()
  listeners.set(key, subscribed)
  subscribed.add(listener)
  return () => {
    subscribed.delete(listener)
    if (subscribed.size === 0) {
      listeners.delete(key)
      published.delete(key)
    }
  }
}
