// Why: the popover shows how much of a window is spent, but not whether that
// spend is ahead of or behind an even burn through the window. Pace closes that
// gap by comparing usage against the elapsed fraction of the window.
// Pure (no platform imports) — safe to bundle in both the renderer and mobile.

import type { RateLimitWindow } from './rate-limit-types'
import { clampUsedPercent } from './usage-percentage-display'

export type UsagePaceStage = 'on-pace' | 'reserve' | 'deficit'

export type UsagePace = {
  stage: UsagePaceStage
  /** Signed distance from the even burn: positive spends fast, negative spends slow. */
  deltaPercent: number
  /** Whole-percent magnitude of `deltaPercent`, the value the copy reports. */
  displayDeltaPercent: number
  /** Even-burn budget for the elapsed slice of the window; the bar marker sits here. */
  expectedUsedPercent: number
  /** The same rounded value the panel prints, so the reported delta reconciles on screen. */
  usedPercent: number
  /** True when the current burn rate still reaches the reset with capacity left. */
  willLastToReset: boolean
  /** Projected time to 100%, or null when the window lasts to reset. */
  runsOutInMs: number | null
}

/** Deltas at or under this read as noise rather than a trend. */
export const USAGE_PACE_ON_PACE_BAND_PERCENT = 2

/** Below this much elapsed window, a burn rate extrapolated from it is fiction. */
export const USAGE_PACE_MIN_ELAPSED_PERCENT = 3

/**
 * Measures a window's spend against an even burn through it.
 *
 * Returns null wherever the reading would be invented rather than measured: no
 * reset timestamp, a reset already past, a reset further out than the window is
 * long (so `resetsAt` and `windowMinutes` disagree), or too little of the window
 * elapsed to extrapolate from.
 */
export function getUsagePace(window: RateLimitWindow, now: number): UsagePace | null {
  const { resetsAt, windowMinutes } = window
  if (resetsAt == null || !Number.isFinite(resetsAt) || !Number.isFinite(now)) {
    return null
  }
  if (!Number.isFinite(windowMinutes) || windowMinutes <= 0) {
    return null
  }

  const durationMs = windowMinutes * 60_000
  const remainingMs = resetsAt - now
  // Why: a reset further out than the window is long means resetsAt and
  // windowMinutes disagree (stale snapshot, or a window Orca mislabels), and an
  // even-burn budget derived from that pair would be invented, not measured.
  if (remainingMs <= 0 || remainingMs > durationMs) {
    return null
  }

  const elapsedMs = durationMs - remainingMs
  const expectedUsedPercent = (elapsedMs / durationMs) * 100
  if (expectedUsedPercent < USAGE_PACE_MIN_ELAPSED_PERCENT) {
    return null
  }

  const usedPercent = clampUsedPercent(window.usedPercent)
  const deltaPercent = usedPercent - expectedUsedPercent
  const displayDeltaPercent = Math.round(Math.abs(deltaPercent))
  // Why: stage off the rounded magnitude so the band and the printed number can
  // never disagree — a "2% in deficit" line under a ±2 on-pace band reads broken.
  const stage: UsagePaceStage =
    displayDeltaPercent <= USAGE_PACE_ON_PACE_BAND_PERCENT
      ? 'on-pace'
      : deltaPercent > 0
        ? 'deficit'
        : 'reserve'

  return {
    stage,
    deltaPercent,
    displayDeltaPercent,
    expectedUsedPercent,
    usedPercent,
    ...projectRunOut(usedPercent, elapsedMs, remainingMs)
  }
}

/**
 * Extends the burn rate observed so far to the end of the window: does the
 * remaining capacity outlast the reset, and if not, how long until it is gone.
 */
function projectRunOut(
  usedPercent: number,
  elapsedMs: number,
  remainingMs: number
): { willLastToReset: boolean; runsOutInMs: number | null } {
  if (usedPercent >= 100) {
    return { willLastToReset: false, runsOutInMs: 0 }
  }
  if (usedPercent <= 0) {
    return { willLastToReset: true, runsOutInMs: null }
  }
  const projectedMs = ((100 - usedPercent) * elapsedMs) / usedPercent
  return projectedMs >= remainingMs
    ? { willLastToReset: true, runsOutInMs: null }
    : { willLastToReset: false, runsOutInMs: projectedMs }
}
