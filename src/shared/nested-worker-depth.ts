import type { GlobalSettings } from './global-settings-types'

/**
 * How deep dispatched workers may nest. 1 means a coordinator dispatches
 * workers and those workers may not dispatch further — the behaviour Orca
 * documented but never actually enforced.
 */
export const NESTED_WORKER_MAX_DEPTH_DEFAULT = 1

/** Root coordinators are depth 0; the first generation of workers is depth 1. */
export const ROOT_DISPATCH_DEPTH = 0

export const NESTED_WORKER_DEPTH_EXCEEDED_CODE = 'nested_worker_depth_exceeded'

export function nestedWorkerDepthExceededMessage(childDepth: number, maxDepth: number): string {
  // Why "complete this task yourself": a refusal alone leaves the worker looping
  // on a capability it will never get.
  return (
    `Sub-worker dispatch is not permitted at depth ${childDepth} (max ${maxDepth}). ` +
    'Complete this task yourself.'
  )
}

export const NESTED_WORKER_DEPTH_EXCEEDED_NEXT_STEPS: readonly string[] = [
  'Do the work in this terminal instead of dispatching a sub-worker.',
  'To allow deeper nesting, open Settings → Orchestration in the Orca desktop app and raise "Nested worker depth".'
]

/**
 * Clamp to a usable integer. Anything that is not a safe whole number >= 1 falls back
 * to the default rather than disabling the fence: a malformed setting must not
 * be a way to get unlimited nesting.
 */
export function resolveNestedWorkerMaxDepth(
  settings: Pick<GlobalSettings, 'nestedWorkerMaxDepth'> | null | undefined
): number {
  const raw = settings?.nestedWorkerMaxDepth
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 1) {
    return NESTED_WORKER_MAX_DEPTH_DEFAULT
  }
  return raw
}
