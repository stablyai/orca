export type NestedWorkerDepthSettings = {
  /** Maximum worker nesting; 1 forbids sub-workers. Renderer-only: omit from SettingsUpdate RPC so workers cannot raise their cap. */
  nestedWorkerMaxDepth?: number
  /** One-shot guard: a stored 1 from the old default moves to 4 once; later choices stick. */
  nestedWorkerMaxDepthDefaultedToFour?: boolean
}

/** Worker nesting limit; a backstop against runaway loops of workers starting workers. */
export const NESTED_WORKER_MAX_DEPTH_DEFAULT = 4

/** The pre-4 default, persisted in full so it cannot be told apart from a deliberate choice. */
const LEGACY_NESTED_WORKER_MAX_DEPTH_DEFAULT = 1

/** Root coordinators are depth 0; the first generation of workers is depth 1. */
export const ROOT_DISPATCH_DEPTH = 0

export const NESTED_WORKER_DEPTH_EXCEEDED_CODE = 'nested_worker_depth_exceeded'

export function nestedWorkerDepthExceededMessage(childDepth: number, maxDepth: number): string {
  // Name the next step or refused workers loop on unavailable dispatch.
  return (
    `Workers can nest at most ${maxDepth} ${maxDepth === 1 ? 'level' : 'levels'} deep, so this worker can't start another ` +
    `(depth ${childDepth}). Finish this task here.`
  )
}

export const NESTED_WORKER_DEPTH_EXCEEDED_NEXT_STEPS: readonly string[] = [
  'Finish the task in this terminal instead of starting another worker.',
  'To allow deeper nesting, ask the user to raise "Nested worker depth" in Settings → Orchestration of the Orca desktop app.'
]

/** Reject unsafe/noninteger values below one to the default; malformed settings cannot disable the depth fence. */
export function resolveNestedWorkerMaxDepth(
  settings: Pick<NestedWorkerDepthSettings, 'nestedWorkerMaxDepth'> | null | undefined
): number {
  const raw = settings?.nestedWorkerMaxDepth
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 1) {
    return NESTED_WORKER_MAX_DEPTH_DEFAULT
  }
  return raw
}

/** Move the old default of 1 to 4 once; higher values and any later choice stay. */
export function migrateNestedWorkerMaxDepthDefault(
  settings: NestedWorkerDepthSettings | undefined
): Required<NestedWorkerDepthSettings> {
  const current = resolveNestedWorkerMaxDepth(settings)
  return {
    nestedWorkerMaxDepth:
      settings?.nestedWorkerMaxDepthDefaultedToFour !== true &&
      current === LEGACY_NESTED_WORKER_MAX_DEPTH_DEFAULT
        ? NESTED_WORKER_MAX_DEPTH_DEFAULT
        : current,
    nestedWorkerMaxDepthDefaultedToFour: true
  }
}
