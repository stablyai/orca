/** The Run and Debug panel listens for this to show the launch confirmation for `configName`. */
export const DEBUG_OPEN_RUN_AND_DEBUG_EVENT = 'orca:debug-open-run-and-debug'

export type DebugOpenRunAndDebugDetail = {
  configName: string | null
  /** True when the configuration only needs a person to confirm it before it runs. */
  confirm: boolean
  message?: string
}

// The panel is lazy: an F5 that opens the tab fires before it mounts, so it reads the request on mount.
const PENDING_TTL_MS = 5000
let pending: { detail: DebugOpenRunAndDebugDetail; at: number } | null = null

export function requestRunAndDebug(detail: DebugOpenRunAndDebugDetail): void {
  pending = { detail, at: Date.now() }
  window.dispatchEvent(new CustomEvent(DEBUG_OPEN_RUN_AND_DEBUG_EVENT, { detail }))
}

/** The request no panel has handled yet, at most once and only while fresh. */
export function takeRunAndDebugRequest(): DebugOpenRunAndDebugDetail | null {
  const request = pending
  pending = null
  return request && Date.now() - request.at <= PENDING_TTL_MS ? request.detail : null
}

function isDetail(value: unknown): value is DebugOpenRunAndDebugDetail {
  return typeof value === 'object' && value !== null && 'confirm' in value
}

export function onRunAndDebugRequest(
  listener: (detail: DebugOpenRunAndDebugDetail) => void
): () => void {
  const handle = (event: Event): void => {
    const detail = event instanceof CustomEvent ? event.detail : null
    if (isDetail(detail)) {
      pending = null
      listener(detail)
    }
  }
  window.addEventListener(DEBUG_OPEN_RUN_AND_DEBUG_EVENT, handle)
  return () => window.removeEventListener(DEBUG_OPEN_RUN_AND_DEBUG_EVENT, handle)
}
