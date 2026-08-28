// Transport background and the allowlisting answer for security teams: docs/reference/agent-hook-transport.md
//
// Why (#11217): enterprise IDS/AV products inspect loopback HTTP bodies and reset the hook POST
// mid-flight when the agent's own tool I/O happens to match an LFI/command-injection signature.
// The listener fails open on every error, so a reset arrives as a swallowed exception and agent
// status stops with no diagnostic anywhere. Classifying the truncation is what makes it reportable.

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

/**
 * Truncation is only interference when Orca did not cause it. `Content-Length` must be present and
 * unmet: a chunked body or a completed one proves nothing, and reporting those would make the
 * signal useless.
 */
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

/** Why: one truncation can be a crashed agent mid-write; a repeat is a device on the loopback path. */
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

/**
 * Counts truncated hook POSTs and reports exactly once, at `threshold`. Counting continues after
 * the report so a diagnostics reader can still see the magnitude without re-notifying per event.
 */
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

/**
 * Shared operator-facing text. Names the likely cause first but not exclusively: the hook client's
 * own `--max-time` can also cut a body if this process stalls, and claiming certainty would send a
 * user to their IT department over a main-thread hang.
 */
export function describeHookTransportInterference(report: HookTransportInterferenceReport): string {
  return (
    `[agent-hooks] ${report.count} agent-status POSTs were cut off mid-body on loopback ` +
    `(last: ${report.bytesRead}/${report.contentLength} bytes${report.source ? `, /hook/${report.source}` : ''}). ` +
    'Agent status will be missing for every runtime until this stops. Most likely local network ' +
    'security software is inspecting and blocking loopback HTTP; less likely, this process stalled ' +
    'past the hook client timeout. See docs/reference/agent-hook-transport.md.'
  )
}
