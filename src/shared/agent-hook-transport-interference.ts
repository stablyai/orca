// Loopback IDS/AV resets otherwise disappear into fail-open hook errors; report truncated bodies (#11217). See docs/reference/agent-hook-transport.md.

/** Thrown by the listener when a request closed before `end` with fewer bytes than `Content-Length` promised. */
export class HookRequestTruncatedError extends Error {
  readonly bytesRead: number
  readonly contentLength: number

  constructor(bytesRead: number, contentLength: number) {
    super(`hook request truncated after ${bytesRead} of ${contentLength} bytes`)
    this.name = 'HookRequestTruncatedError'
    this.bytesRead = bytesRead
    this.contentLength = contentLength
  }
}

export function isHookRequestTruncatedError(error: unknown): error is HookRequestTruncatedError {
  return error instanceof HookRequestTruncatedError
}

/** Only an unmet, usable Content-Length proves truncation; chunked/completed bodies carry no evidence. */
export function classifyTruncatedHookRequest(
  contentLengthHeader: string | string[] | undefined,
  bytesRead: number
): HookRequestTruncatedError | null {
  const raw = Array.isArray(contentLengthHeader) ? contentLengthHeader[0] : contentLengthHeader
  if (!raw || !/^\d+$/.test(raw.trim())) {
    return null
  }
  const contentLength = Number(raw.trim())
  return bytesRead < contentLength ? new HookRequestTruncatedError(bytesRead, contentLength) : null
}

/** Repeated truncations suggest loopback interference; one may be a crashed writer. */
export const HOOK_TRANSPORT_INTERFERENCE_THRESHOLD = 3

export type HookTransportInterferenceReport = {
  /** Total authenticated-but-truncated hook POSTs observed since start. */
  count: number
  /** The hook route of the most recent truncation, when the URL resolved to one. */
  source: string | null
  bytesRead: number
  contentLength: number
}

export type HookTransportInterferenceTracker = {
  record: (detail: { source: string | null; error: HookRequestTruncatedError }) => void
  getCount: () => number
  reset: () => void
}

/** Report once at threshold, then keep counting for diagnostics without repeat notifications. */
export function createHookTransportInterferenceTracker(
  onThresholdReached: (report: HookTransportInterferenceReport) => void,
  threshold: number = HOOK_TRANSPORT_INTERFERENCE_THRESHOLD
): HookTransportInterferenceTracker {
  let count = 0
  let reported = false
  return {
    record: ({ source, error }) => {
      count += 1
      if (reported || count < threshold) {
        return
      }
      reported = true
      onThresholdReached({
        count,
        source,
        bytesRead: error.bytesRead,
        contentLength: error.contentLength
      })
    },
    getCount: () => count,
    reset: () => {
      count = 0
      reported = false
    }
  }
}

/** Name likely interference without certainty: client max-time can also expire during a main-thread stall. */
export function describeHookTransportInterference(report: HookTransportInterferenceReport): string {
  return (
    `[agent-hooks] ${report.count} agent-status POSTs were cut off mid-body on loopback ` +
    `(last: ${report.bytesRead}/${report.contentLength} bytes${report.source ? `, /hook/${report.source}` : ''}). ` +
    'Agent status will be missing for every runtime until this stops. Most likely local network ' +
    'security software is inspecting and blocking loopback HTTP; less likely, this process stalled ' +
    'past the hook client timeout. See docs/reference/agent-hook-transport.md.'
  )
}
