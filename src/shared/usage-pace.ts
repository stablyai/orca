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

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

type WindowTiming = {
  durationMs: number
  remainingMs: number
  elapsedMs: number
  expectedUsedPercent: number
}

/**
 * The window's own timeline, or null where it cannot be trusted: no reset
 * timestamp, a reset already past, or a reset further out than the window is
 * long (so `resetsAt` and `windowMinutes` disagree — a stale snapshot, or a
 * window Orca mislabels — and any budget from that pair would be invented).
 */
function resolveWindowTiming(window: RateLimitWindow, now: number): WindowTiming | null {
  const { resetsAt, windowMinutes } = window
  if (resetsAt == null || !Number.isFinite(resetsAt) || !Number.isFinite(now)) {
    return null
  }
  if (!Number.isFinite(windowMinutes) || windowMinutes <= 0) {
    return null
  }
  const durationMs = windowMinutes * MINUTE_MS
  const remainingMs = resetsAt - now
  if (remainingMs <= 0 || remainingMs > durationMs) {
    return null
  }
  const elapsedMs = durationMs - remainingMs
  return {
    durationMs,
    remainingMs,
    elapsedMs,
    expectedUsedPercent: (elapsedMs / durationMs) * 100
  }
}

/**
 * Measures a window's spend against an even burn through it. Returns null
 * wherever the reading would be invented rather than measured — see
 * `resolveWindowTiming`, plus too little of the window elapsed to extrapolate.
 */
export function getUsagePace(window: RateLimitWindow, now: number): UsagePace | null {
  const timing = resolveWindowTiming(window, now)
  if (!timing || timing.expectedUsedPercent < USAGE_PACE_MIN_ELAPSED_PERCENT) {
    return null
  }
  const { expectedUsedPercent, elapsedMs, remainingMs } = timing

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

/**
 * When the pace reading next turns over, as a timestamp.
 *
 * Why: the panel's clock wakes on the reset countdown's boundaries, which are
 * hourly once a reset is more than a day out. Pace moves on its own schedule —
 * finer than that near a threshold — so it has to name its own wake-up times or
 * the popover keeps showing a superseded reading for up to an hour.
 */
export function getUsagePaceNextChangeAt(window: RateLimitWindow, now: number): number | null {
  const timing = resolveWindowTiming(window, now)
  if (!timing) {
    return null
  }
  const { durationMs, remainingMs, elapsedMs, expectedUsedPercent } = timing
  const msPerPercent = durationMs / 100

  if (expectedUsedPercent < USAGE_PACE_MIN_ELAPSED_PERCENT) {
    return now + (USAGE_PACE_MIN_ELAPSED_PERCENT - expectedUsedPercent) * msPerPercent
  }

  const usedPercent = clampUsedPercent(window.usedPercent)
  const delays: number[] = []

  // The printed delta is round(|used − expected|). Usage holds still between
  // fetches while expected only grows, so the reading turns over each time that
  // difference passes a half-percent.
  const deltaPercent = usedPercent - expectedUsedPercent
  delays.push((deltaPercent - (Math.ceil(deltaPercent - 0.5) - 0.5)) * msPerPercent)

  // Spend projected forward grows at this rate per elapsed millisecond.
  const burnRatio = usedPercent > 0 && usedPercent < 100 ? (100 - usedPercent) / usedPercent : 0
  if (burnRatio > 0) {
    const projectedMs = burnRatio * elapsedMs
    // The projection climbs while the time left falls; the lasts/runs-out
    // verdict flips where they meet.
    delays.push((remainingMs - projectedMs) / (1 + burnRatio))
    if (projectedMs < remainingMs) {
      // "Runs out in 2d 2h" is floored, to the hour past a day and the minute below it.
      const unitMs = projectedMs >= DAY_MS ? HOUR_MS : MINUTE_MS
      const nextBoundaryMs = (Math.floor(projectedMs / unitMs) + 1) * unitMs
      delays.push((nextBoundaryMs - projectedMs) / burnRatio)
    }
  }

  const soonest = Math.min(...delays.filter((delay) => Number.isFinite(delay) && delay > 0))
  return Number.isFinite(soonest) ? now + soonest : null
}
