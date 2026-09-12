/**
 * Detects intentional "hard scroll up" on a long worktree list so we can offer
 * a jump-to-top control. Tuned for trackpad wheel streams and scrollbar drags.
 */

export const HARD_SCROLL_UP = {
  /** Only samples inside this window contribute to intent. */
  windowMs: 480,
  /** List must be scrollable by at least this much. */
  minScrollablePx: 480,
  /** Must be at least this far from the top before the button can appear. */
  minDepthPx: 280,
  /** Hide once the viewport is this close to the top. */
  nearTopPx: 56,
  /** Minimum upward wheel samples in the window. */
  minUpEvents: 3,
  /** Accumulated |deltaY| (px) for a sustained hard-up gesture. */
  hardTotalDeltaPx: 720,
  /** Peak single-sample |deltaY| that marks a fling/burst. */
  burstPeakDeltaPx: 90,
  /** Accumulated |deltaY| paired with a burst peak. */
  burstTotalDeltaPx: 320,
  /** Scroll-position velocity (px/s upward) that counts as hard drag/fling. */
  hardVelocityPxPerSec: 1600,
  /** How long hard velocity must be sustained. */
  velocitySustainMs: 160,
  /** Clear intent after idle so the button does not linger forever. */
  hideAfterIdleMs: 2600,
  /** Significant down-scroll cancels upward intent. */
  significantDownDeltaPx: 48,
  /** Cap stored samples so long sessions stay cheap. */
  maxSamples: 32,
  /** Ignore scroll input this long after a programmatic jump to top. */
  suppressAfterJumpMs: 120
} as const

export type HardScrollUpWheelSample = {
  t: number
  /** Positive = toward top (up). Normalized to CSS pixels. */
  upDeltaPx: number
}

export type HardScrollUpScrollSample = {
  t: number
  scrollTop: number
}

export type HardScrollUpDetectorState = {
  // Why: wheel + scroll both fire for the same gesture; keep them separate so
  // wheel magnitude is not double-counted with scrollTop deltas.
  wheelSamples: HardScrollUpWheelSample[]
  scrollSamples: HardScrollUpScrollSample[]
  wheelDownDeltaPx: number
  scrollDownDeltaPx: number
  visible: boolean
  lastIntentAt: number
}

export type HardScrollUpViewport = {
  scrollTop: number
  maxScroll: number
  t: number
}

export function createHardScrollUpDetectorState(): HardScrollUpDetectorState {
  return {
    wheelSamples: [],
    scrollSamples: [],
    wheelDownDeltaPx: 0,
    scrollDownDeltaPx: 0,
    visible: false,
    lastIntentAt: 0
  }
}

export function normalizeWheelDeltaY(deltaY: number, deltaMode: number): number {
  // WheelEvent.DOM_DELTA_LINE / DOM_DELTA_PAGE — convert to approximate CSS px.
  if (deltaMode === 1) {
    return deltaY * 16
  }
  if (deltaMode === 2) {
    return deltaY * 600
  }
  return deltaY
}

function pruneByTime<T extends { t: number }>(samples: readonly T[], t: number): T[] {
  const cutoff = t - HARD_SCROLL_UP.windowMs
  const pruned = samples.filter((sample) => sample.t >= cutoff)
  if (pruned.length <= HARD_SCROLL_UP.maxSamples) {
    return pruned
  }
  return pruned.slice(pruned.length - HARD_SCROLL_UP.maxSamples)
}

function isListLongEnough(maxScroll: number): boolean {
  return maxScroll >= HARD_SCROLL_UP.minScrollablePx
}

function isDeepEnough(scrollTop: number): boolean {
  return scrollTop >= HARD_SCROLL_UP.minDepthPx
}

function isNearTop(scrollTop: number): boolean {
  return scrollTop <= HARD_SCROLL_UP.nearTopPx
}

function computeWheelIntent(samples: readonly HardScrollUpWheelSample[]): boolean {
  const upSamples = samples.filter((sample) => sample.upDeltaPx > 0)
  if (upSamples.length < HARD_SCROLL_UP.minUpEvents) {
    return false
  }

  let totalUp = 0
  let peakUp = 0
  for (const sample of upSamples) {
    totalUp += sample.upDeltaPx
    if (sample.upDeltaPx > peakUp) {
      peakUp = sample.upDeltaPx
    }
  }

  if (totalUp >= HARD_SCROLL_UP.hardTotalDeltaPx) {
    return true
  }

  return peakUp >= HARD_SCROLL_UP.burstPeakDeltaPx && totalUp >= HARD_SCROLL_UP.burstTotalDeltaPx
}

function computeVelocityIntent(samples: readonly HardScrollUpScrollSample[], t: number): boolean {
  if (samples.length < 2) {
    return false
  }

  const newest = samples.at(-1)
  if (!newest || t - newest.t > HARD_SCROLL_UP.velocitySustainMs) {
    return false
  }

  // Walk backward to the oldest sample still inside the window, then measure
  // average upward velocity across that span.
  let oldest = newest
  for (let i = samples.length - 2; i >= 0; i -= 1) {
    const sample = samples.at(i)
    if (!sample) {
      continue
    }
    if (newest.t - sample.t > HARD_SCROLL_UP.windowMs) {
      break
    }
    oldest = sample
  }

  const elapsedMs = newest.t - oldest.t
  if (elapsedMs < HARD_SCROLL_UP.velocitySustainMs) {
    return false
  }

  const upwardPx = oldest.scrollTop - newest.scrollTop
  if (upwardPx <= 0) {
    return false
  }

  const velocity = (upwardPx / elapsedMs) * 1000
  return velocity >= HARD_SCROLL_UP.hardVelocityPxPerSec
}

function withVisibility(
  state: HardScrollUpDetectorState,
  { t, scrollTop, maxScroll, intent }: HardScrollUpViewport & { intent: boolean }
): HardScrollUpDetectorState {
  if (!isListLongEnough(maxScroll) || isNearTop(scrollTop)) {
    if (
      !state.visible &&
      state.wheelSamples.length === 0 &&
      state.scrollSamples.length === 0 &&
      state.wheelDownDeltaPx === 0 &&
      state.scrollDownDeltaPx === 0 &&
      state.lastIntentAt === 0
    ) {
      return state
    }
    return createHardScrollUpDetectorState()
  }

  if (intent && isDeepEnough(scrollTop)) {
    return {
      ...state,
      visible: true,
      lastIntentAt: t
    }
  }

  // Why: hide on the deadline itself even if only non-intent scroll noise arrives;
  // the hook also arms a timer, but event-driven hide must not depend on timer re-arms.
  if (state.visible && t - state.lastIntentAt >= HARD_SCROLL_UP.hideAfterIdleMs) {
    return createHardScrollUpDetectorState()
  }

  return state
}

/**
 * Ingest a wheel event. `deltaY` follows the browser convention (negative = up).
 */
export function reduceHardScrollUpOnWheel(
  state: HardScrollUpDetectorState,
  {
    deltaY,
    deltaMode = 0,
    scrollTop,
    maxScroll,
    t
  }: HardScrollUpViewport & { deltaY: number; deltaMode?: number }
): HardScrollUpDetectorState {
  if (!isListLongEnough(maxScroll)) {
    return createHardScrollUpDetectorState()
  }

  if (isNearTop(scrollTop)) {
    return withVisibility(state, { t, scrollTop, maxScroll, intent: false })
  }

  const pixelDeltaY = normalizeWheelDeltaY(deltaY, deltaMode)
  // Browser: negative deltaY = scroll up (content moves down, viewport toward top).
  const upDeltaPx = -pixelDeltaY
  const wheelDownDeltaPx =
    upDeltaPx < 0
      ? state.wheelDownDeltaPx + Math.abs(upDeltaPx)
      : upDeltaPx > 0
        ? 0
        : state.wheelDownDeltaPx

  if (wheelDownDeltaPx >= HARD_SCROLL_UP.significantDownDeltaPx) {
    return createHardScrollUpDetectorState()
  }

  const nextWheelSamples = pruneByTime(
    upDeltaPx > 0 ? [...state.wheelSamples, { t, upDeltaPx }] : [],
    t
  )
  const nextScrollSamples = pruneByTime(state.scrollSamples, t)

  const intent = upDeltaPx > 0 && computeWheelIntent(nextWheelSamples)
  return withVisibility(
    {
      ...state,
      wheelSamples: nextWheelSamples,
      scrollSamples: nextScrollSamples,
      wheelDownDeltaPx
    },
    { t, scrollTop, maxScroll, intent }
  )
}

/**
 * Ingest a scroll position sample from an active scrollbar/touch gesture.
 * Velocity-based; ignores tiny no-op scrolls.
 */
export function reduceHardScrollUpOnScroll(
  state: HardScrollUpDetectorState,
  { scrollTop, maxScroll, t }: HardScrollUpViewport
): HardScrollUpDetectorState {
  if (!isListLongEnough(maxScroll)) {
    return createHardScrollUpDetectorState()
  }

  if (isNearTop(scrollTop)) {
    return withVisibility(state, { t, scrollTop, maxScroll, intent: false })
  }

  const last = state.scrollSamples.at(-1)
  const downDeltaPx = last ? Math.max(0, scrollTop - last.scrollTop) : 0
  const upDeltaPx = last ? Math.max(0, last.scrollTop - scrollTop) : 0
  const scrollDownDeltaPx =
    downDeltaPx > 0
      ? state.scrollDownDeltaPx + downDeltaPx
      : upDeltaPx > 0
        ? 0
        : state.scrollDownDeltaPx

  if (scrollDownDeltaPx >= HARD_SCROLL_UP.significantDownDeltaPx) {
    return createHardScrollUpDetectorState()
  }

  // Ignore pure no-ops so a stalled scrollbar does not pad the window.
  if (last && last.scrollTop === scrollTop && t - last.t < 16) {
    return withVisibility(state, {
      t,
      scrollTop,
      maxScroll,
      intent: false
    })
  }

  const nextScrollSamples = pruneByTime(
    [...(downDeltaPx > 0 ? [] : state.scrollSamples), { t, scrollTop }],
    t
  )
  const nextWheelSamples = pruneByTime(state.wheelSamples, t)

  const intent = upDeltaPx > 0 && computeVelocityIntent(nextScrollSamples, t)
  return withVisibility(
    {
      ...state,
      wheelSamples: nextWheelSamples,
      scrollSamples: nextScrollSamples,
      scrollDownDeltaPx
    },
    { t, scrollTop, maxScroll, intent }
  )
}

/** Idle tick so the button auto-hides without requiring more input. */
export function reduceHardScrollUpOnIdle(
  state: HardScrollUpDetectorState,
  { scrollTop, maxScroll, t }: HardScrollUpViewport
): HardScrollUpDetectorState {
  if (!state.visible) {
    return state
  }
  return withVisibility(state, { t, scrollTop, maxScroll, intent: false })
}

export function reduceHardScrollUpOnDismiss(
  state: HardScrollUpDetectorState
): HardScrollUpDetectorState {
  if (
    !state.visible &&
    state.wheelSamples.length === 0 &&
    state.scrollSamples.length === 0 &&
    state.wheelDownDeltaPx === 0 &&
    state.scrollDownDeltaPx === 0
  ) {
    return state
  }
  return createHardScrollUpDetectorState()
}
