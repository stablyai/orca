import { clampNativeChatVisualHeight } from './native-chat-visual-shell'

const WINDOW_MS = 1_000
const MAX_CHANGES_PER_WINDOW = 20
// A page sized from the frame (100vh plus a margin) grows by the same small step on every report;
// an animated expansion grows by varying steps and is left alone.
const RUNAWAY_STEP_PX = 64
const RUNAWAY_STEP_TOLERANCE_PX = 1
const RUNAWAY_GAP_MS = 500
const RUNAWAY_STREAK = 10

export type NativeChatVisualHeightDecision =
  | { kind: 'apply'; height: number }
  | { kind: 'defer'; retryInMs: number }
  | { kind: 'ignore' }

/**
 * Turns a visual's reported heights into frame heights: clamped, rate-limited, and frozen against
 * further growth once the page is plainly growing because the frame grew (the same small step, again
 * and again). Shrinking stays allowed.
 */
export function createNativeChatVisualHeightGovernor(): {
  decide: (reported: number, now: number) => NativeChatVisualHeightDecision
} {
  let applied: number | null = null
  let windowStart = 0
  let changes = 0
  let lastGrowthAt = -Infinity
  let lastStep = 0
  let streak = 0
  let growthFrozen = false

  return {
    decide(reported, now) {
      const height = clampNativeChatVisualHeight(reported)
      if (height === applied) {
        return { kind: 'ignore' }
      }
      const grows = applied !== null && height > applied
      if (grows && growthFrozen) {
        return { kind: 'ignore' }
      }
      if (now - windowStart >= WINDOW_MS) {
        windowStart = now
        changes = 0
      }
      if (changes >= MAX_CHANGES_PER_WINDOW) {
        return { kind: 'defer', retryInMs: windowStart + WINDOW_MS - now }
      }
      if (grows && applied !== null) {
        const step = height - applied
        const sameSmallStep =
          step <= RUNAWAY_STEP_PX && Math.abs(step - lastStep) <= RUNAWAY_STEP_TOLERANCE_PX
        streak = sameSmallStep && now - lastGrowthAt < RUNAWAY_GAP_MS ? streak + 1 : 0
        lastGrowthAt = now
        lastStep = step
        if (streak >= RUNAWAY_STREAK) {
          growthFrozen = true
          return { kind: 'ignore' }
        }
      } else {
        streak = 0
      }
      changes += 1
      applied = height
      return { kind: 'apply', height }
    }
  }
}
