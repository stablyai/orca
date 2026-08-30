/**
 * The main->renderer `window:close-requested` message.
 *
 * `localPtysSurviveQuit` is the one fact the renderer cannot work out for itself:
 * whether a quit hands this window's local shells to the daemon or ends them with
 * the process. Main answers it per request because the answer changes over a run —
 * the daemon can fail to install, fail open, or be replaced by the degraded
 * provider that spawns fresh sessions in-process.
 */
export type WindowCloseRequestPayload = {
  isQuitting: boolean
  localPtysSurviveQuit: boolean
  requestId?: number
}

/**
 * Reads an incoming payload on the safe side.
 *
 * Only an explicit `true` counts as survival: an absent or malformed field is an
 * undetermined answer, and spending one as "the work keeps running" is what closes
 * over live processes with no warning (docs/reference/ssh-execution-boundary.md).
 */
export function readWindowCloseRequestPayload(value: unknown): WindowCloseRequestPayload {
  const data = (value ?? {}) as Partial<WindowCloseRequestPayload>
  return {
    isQuitting: data.isQuitting === true,
    localPtysSurviveQuit: data.localPtysSurviveQuit === true,
    requestId: typeof data.requestId === 'number' ? data.requestId : undefined
  }
}
