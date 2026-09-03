import { describe, expect, it } from 'vitest'
import {
  createInteractiveEchoLatencyTracker,
  MAX_ECHO_LATENCY_ALLOWANCE_MS
} from './interactive-echo-latency'

const FOREGROUND_INTERACTIVE_REDRAW_WINDOW_MS = 150

/** Drives one keystroke and its echo `rttMs` later. */
function typeAndEcho(
  tracker: ReturnType<typeof createInteractiveEchoLatencyTracker>,
  startAt: number,
  rttMs: number
): void {
  tracker.recordInput(startAt)
  tracker.recordOutput(startAt + rttMs)
}

describe('interactive echo latency', () => {
  it('adds nothing before any sample exists', () => {
    expect(createInteractiveEchoLatencyTracker().allowanceMs()).toBe(0)
  })

  it('leaves a local pane at the base window', () => {
    const tracker = createInteractiveEchoLatencyTracker()
    for (let index = 0; index < 8; index++) {
      typeAndEcho(tracker, index * 1_000, 2)
    }
    expect(tracker.allowanceMs()).toBe(2)
  })

  it('keeps a remote pane inside the window at an RTT that would otherwise miss it', () => {
    const tracker = createInteractiveEchoLatencyTracker()
    for (let index = 0; index < 8; index++) {
      typeAndEcho(tracker, index * 1_000, 220)
    }
    // Why this is the regression: 220ms echo lands outside the fixed 150ms window, so the
    // user's own typing stopped being classified as typing until the window widened.
    const widened = FOREGROUND_INTERACTIVE_REDRAW_WINDOW_MS + tracker.allowanceMs()
    expect(220 <= FOREGROUND_INTERACTIVE_REDRAW_WINDOW_MS).toBe(false)
    expect(220 <= widened).toBe(true)
  })

  it('measures from the oldest unmatched keystroke, not the newest', () => {
    const tracker = createInteractiveEchoLatencyTracker()
    tracker.recordInput(0)
    tracker.recordInput(100)
    tracker.recordOutput(200)
    expect(tracker.allowanceMs()).toBe(200)
  })

  it('keeps sampling through pipelined typing instead of only the first key', () => {
    const tracker = createInteractiveEchoLatencyTracker()
    tracker.recordInput(0)
    tracker.recordInput(100)
    tracker.recordOutput(200)
    tracker.recordOutput(300)
    // Both keystrokes are paired, so a sustained burst keeps adapting; a single-slot
    // pending would have dropped the second input and produced no sample at 300.
    expect(tracker.allowanceMs()).toBe(200)
  })

  it('bounds the pending queue when typing outruns the echoes', () => {
    const tracker = createInteractiveEchoLatencyTracker()
    for (let index = 0; index < 200; index++) {
      tracker.recordInput(index)
    }
    tracker.recordOutput(300)
    // The oldest inputs are discarded rather than retained without bound, so the sample
    // reflects a recent keystroke instead of one 300ms stale.
    expect(tracker.allowanceMs()).toBeLessThan(200)
  })

  it('ignores agent work that is too slow to be an echo', () => {
    const tracker = createInteractiveEchoLatencyTracker()
    tracker.recordInput(0)
    tracker.recordOutput(5_000)
    expect(tracker.allowanceMs()).toBe(0)
  })

  it('ignores output that no keystroke is waiting on', () => {
    const tracker = createInteractiveEchoLatencyTracker()
    tracker.recordOutput(500)
    tracker.recordOutput(900)
    expect(tracker.allowanceMs()).toBe(0)
  })

  it('does not let one stalled chunk widen the window for the rest', () => {
    const tracker = createInteractiveEchoLatencyTracker()
    for (let index = 0; index < 7; index++) {
      typeAndEcho(tracker, index * 1_000, 60)
    }
    typeAndEcho(tracker, 7_000, 1_900)
    expect(tracker.allowanceMs()).toBe(60)
  })

  it('averages the two middle samples when the count is even', () => {
    const tracker = createInteractiveEchoLatencyTracker()
    for (const rtt of [10, 20, 30, 50]) {
      typeAndEcho(tracker, rtt * 1_000, rtt)
    }
    // Ordered [10, 20, 30, 50] -> (20 + 30) / 2, not the upper middle (30).
    expect(tracker.allowanceMs()).toBe(25)
  })

  it('caps the allowance so a bad link cannot widen the window without bound', () => {
    const tracker = createInteractiveEchoLatencyTracker()
    for (let index = 0; index < 8; index++) {
      typeAndEcho(tracker, index * 5_000, 1_800)
    }
    expect(tracker.allowanceMs()).toBe(MAX_ECHO_LATENCY_ALLOWANCE_MS)
  })

  it('forgets an old link speed once newer samples fill the window', () => {
    const tracker = createInteractiveEchoLatencyTracker()
    for (let index = 0; index < 8; index++) {
      typeAndEcho(tracker, index * 1_000, 400)
    }
    for (let index = 8; index < 16; index++) {
      typeAndEcho(tracker, index * 1_000, 5)
    }
    expect(tracker.allowanceMs()).toBe(5)
  })
})
