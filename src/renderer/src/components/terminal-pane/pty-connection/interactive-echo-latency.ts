// Why: the interactive-redraw windows are calibrated against local echo (2ms plain
// shell, ~22ms Codex composer). On a remote runtime the echo cannot arrive before one
// round trip, so a fixed window silently stops recognizing the user's own typing above
// ~150ms RTT and drops repaints into the 250ms/1000ms fallback lane (#16265). Measuring
// the pane's own input -> first-output delay lets the same windows widen by exactly what
// the link costs, and leaves local panes untouched because their allowance is ~0.

/** Beyond this a chunk is agent work, not an echo, so it must not inflate the estimate. */
const MAX_ECHO_LATENCY_SAMPLE_MS = 2_000
/** Caps how far a slow link may widen the windows, bounding over-classification. */
export const MAX_ECHO_LATENCY_ALLOWANCE_MS = 500
const ECHO_LATENCY_SAMPLE_COUNT = 8
/** Bounds the queue when a burst of typing outruns the echoes coming back. */
const MAX_PENDING_INPUTS = 32

export type InteractiveEchoLatencyTracker = {
  recordInput: (now: number) => void
  recordOutput: (now: number) => void
  /** Milliseconds to add to a base interactivity window; 0 until a sample exists. */
  allowanceMs: () => number
}

export function createInteractiveEchoLatencyTracker(): InteractiveEchoLatencyTracker {
  const samples: number[] = []
  // FIFO: echo is pipelined, so the chunk arriving now answers the oldest keystroke still
  // outstanding. A single slot would drop every input typed while one is already pending,
  // which thins sampling to roughly one per burst exactly when typing is most sustained.
  const pendingInputs: number[] = []

  return {
    recordInput(now: number): void {
      pendingInputs.push(now)
      if (pendingInputs.length > MAX_PENDING_INPUTS) {
        pendingInputs.shift()
      }
    },
    recordOutput(now: number): void {
      // Drop keystrokes too old to still be awaiting an echo, so one stalled input cannot
      // poison the pairing for every output behind it.
      while (
        pendingInputs.length > 0 &&
        now - (pendingInputs[0] ?? 0) > MAX_ECHO_LATENCY_SAMPLE_MS
      ) {
        pendingInputs.shift()
      }
      const inputAt = pendingInputs.shift()
      if (inputAt === undefined) {
        return
      }
      const sample = now - inputAt
      if (!Number.isFinite(sample) || sample < 0) {
        return
      }
      samples.push(sample)
      if (samples.length > ECHO_LATENCY_SAMPLE_COUNT) {
        samples.shift()
      }
    },
    allowanceMs(): number {
      if (samples.length === 0) {
        return 0
      }
      // Median, not mean: one stalled chunk must not widen the window for the rest.
      const ordered = [...samples].sort((first, second) => first - second)
      const upper = Math.floor(ordered.length / 2)
      const median =
        ordered.length % 2 === 0
          ? ((ordered[upper - 1] ?? 0) + (ordered[upper] ?? 0)) / 2
          : (ordered[upper] ?? 0)
      return Math.min(median, MAX_ECHO_LATENCY_ALLOWANCE_MS)
    }
  }
}
