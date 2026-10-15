import { isPathInsideOrEqual, normalizeRuntimePathForComparison } from '../cross-platform-path'
import type { P4CommandResult } from './p4-command'

// The unopened-files scan (`reconcile -n`) per workspace folder. Even a preview takes the client's
// write lock and makes one server round trip per file, so a scan of a large workspace outlasts the
// panel's refresh: overlapping scans queued on the lock forever and kept the folder open.

type Attempt = { startedAt: number; finishedAt: number }
type ScanState = {
  /** The folder as first asked for; comparison keys are not paths. */
  path: string
  running: { controller: AbortController; done: Promise<P4CommandResult> } | null
  last: (Attempt & { result: P4CommandResult }) | null
  /** The newest scan, when it threw (timed out, mostly); it rests like a finished one. */
  failed: (Attempt & { error: unknown }) | null
  /** A scan that started before this is stale: Orca changed what is opened since. */
  invalidatedAt: number
}

// Rest this many times the last scan's length, so P4V, Unity and sync get the client lock too.
const REST_FACTOR = 3

const scans = new Map<string, ScanState>()
const held = new Map<string, { path: string; count: number }>()

export const HELD_SCAN_MESSAGE = 'This Perforce workspace is being removed.'

function stateFor(cwd: string): ScanState {
  const key = normalizeRuntimePathForComparison(cwd)
  let state = scans.get(key)
  if (!state) {
    state = { path: cwd, running: null, last: null, failed: null, invalidatedAt: 0 }
    scans.set(key, state)
  }
  return state
}

export function isWorkspaceScanHeld(cwd: string): boolean {
  return [...held.values()].some((root) => isPathInsideOrEqual(root.path, cwd))
}

function start(state: ScanState, run: (signal: AbortSignal) => Promise<P4CommandResult>) {
  const controller = new AbortController()
  const startedAt = Date.now()
  const done = run(controller.signal)
    .then(
      (result) => {
        if (!controller.signal.aborted) {
          state.last = { result, startedAt, finishedAt: Date.now() }
          state.failed = null
        }
        return result
      },
      (error: unknown) => {
        if (!controller.signal.aborted) {
          state.failed = { error, startedAt, finishedAt: Date.now() }
        }
        throw error
      }
    )
    .finally(() => {
      if (state.running?.controller === controller) {
        state.running = null
      }
    })
  state.running = { controller, done }
  return done
}

function restMs(attempt: Attempt, minIntervalMs: number): number {
  return Math.max(minIntervalMs, REST_FACTOR * (attempt.finishedAt - attempt.startedAt))
}

/**
 * The folder's scan result. Only a folder never scanned waits for `run`; otherwise the last result
 * answers at once and a new scan starts in the background when it is stale or has rested (a
 * timed-out scan rests too, or it would hold the lock for good). Never two scans at once. A folder
 * whose only scans failed reports the last failure until it has rested.
 */
export async function scanWorkspace(
  cwd: string,
  minIntervalMs: number,
  run: (signal: AbortSignal) => Promise<P4CommandResult>
): Promise<P4CommandResult> {
  if (isWorkspaceScanHeld(cwd)) {
    return { code: null, stdout: '', stderr: HELD_SCAN_MESSAGE }
  }
  const state = stateFor(cwd)
  const { last, failed, running } = state
  const resting = failed !== null && Date.now() - failed.finishedAt < restMs(failed, minIntervalMs)
  if (!last) {
    if (running) {
      return running.done
    }
    if (resting) {
      throw failed.error
    }
    return start(state, run)
  }
  const due =
    !resting &&
    (last.startedAt <= state.invalidatedAt ||
      Date.now() - last.finishedAt >= restMs(last, minIntervalMs))
  if (due && !running) {
    void start(state, run).catch(() => undefined)
  }
  return last.result
}

/** After Orca opens, reverts or submits files there, the next status scans again. */
export function invalidateWorkspaceScan(cwd: string): void {
  const now = Date.now()
  for (const state of scans.values()) {
    if (isPathInsideOrEqual(state.path, cwd) || isPathInsideOrEqual(cwd, state.path)) {
      state.invalidatedAt = now
    }
  }
}

/**
 * Stops the scans under `root` and refuses new ones until released: a copy being deleted must not
 * be kept open by a scan. Resolves once the stopped scans have exited.
 */
export async function holdWorkspaceScansUnder(root: string): Promise<() => void> {
  const key = normalizeRuntimePathForComparison(root)
  held.set(key, { path: root, count: (held.get(key)?.count ?? 0) + 1 })
  const stopping: Promise<unknown>[] = []
  for (const state of scans.values()) {
    if (state.running && isPathInsideOrEqual(root, state.path)) {
      state.running.controller.abort()
      stopping.push(state.running.done.catch(() => undefined))
    }
  }
  await Promise.all(stopping)
  let released = false
  return () => {
    if (released) {
      return
    }
    released = true
    const count = (held.get(key)?.count ?? 1) - 1
    if (count > 0) {
      held.set(key, { path: root, count })
    } else {
      held.delete(key)
    }
  }
}

export function resetWorkspaceScansForTests(): void {
  scans.clear()
  held.clear()
}
