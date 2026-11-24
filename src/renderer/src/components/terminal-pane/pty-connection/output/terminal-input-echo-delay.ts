// Why: the interactive-redraw windows are calibrated against local echo, so a
// remote pane's round trip must widen them or its own typing stops reading as typing (STA-5314).
const INPUT_ECHO_DELAY_SAMPLE_COUNT = 8
// A first output later than this answered something other than the keystroke.
const INPUT_ECHO_DELAY_MAX_SAMPLE_MS = 1000
export const INPUT_ECHO_DELAY_MAX_ALLOWANCE_MS = 500

export type TerminalInputEchoDelay = {
  pendingInputAt: number | null
  samples: number[]
}

export function createTerminalInputEchoDelay(): TerminalInputEchoDelay {
  return { pendingInputAt: null, samples: [] }
}

/** Keeps the oldest unanswered input, so a burst inside one round trip measures that trip. */
export function noteTerminalInputAwaitingEcho(delay: TerminalInputEchoDelay, now: number): void {
  if (
    delay.pendingInputAt === null ||
    now - delay.pendingInputAt > INPUT_ECHO_DELAY_MAX_SAMPLE_MS
  ) {
    delay.pendingInputAt = now
  }
}

export function noteTerminalOutputAfterInput(delay: TerminalInputEchoDelay, now: number): void {
  if (delay.pendingInputAt === null) {
    return
  }
  const sample = now - delay.pendingInputAt
  delay.pendingInputAt = null
  if (sample < 0 || sample > INPUT_ECHO_DELAY_MAX_SAMPLE_MS) {
    return
  }
  delay.samples.push(sample)
  if (delay.samples.length > INPUT_ECHO_DELAY_SAMPLE_COUNT) {
    delay.samples.shift()
  }
}

/**
 * The recent minimum input-to-output delay. Unrelated output only lowers it,
 * which falls back to the local windows; slow app frames cannot inflate it.
 */
export function terminalInputEchoAllowanceMs(delay: TerminalInputEchoDelay): number {
  if (delay.samples.length === 0) {
    return 0
  }
  return Math.min(INPUT_ECHO_DELAY_MAX_ALLOWANCE_MS, Math.min(...delay.samples))
}
