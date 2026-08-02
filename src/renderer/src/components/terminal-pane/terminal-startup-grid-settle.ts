export type TerminalStartupGridDimensions = {
  cols: number
  rows: number
}

export type TerminalStartupGridSettleOptions = {
  isAlive: () => boolean
  isReadyToSettle?: () => boolean
  measure: () => TerminalStartupGridDimensions | null
  onSettled: (dimensions: TerminalStartupGridDimensions | null) => void
  requestFrame: (callback: () => void) => number
  cancelFrame: (handle: number) => void
  minFrames?: number
  stableFrames?: number
  maxFrames?: number
}

export type TerminalStartupGridSettleHandle = {
  cancel: () => void
}

const DEFAULT_MIN_FRAMES = 6
const DEFAULT_STABLE_FRAMES = 2
const DEFAULT_MAX_FRAMES = 12

function usableDimensions(
  dimensions: TerminalStartupGridDimensions | null
): dimensions is TerminalStartupGridDimensions {
  return Boolean(dimensions && dimensions.cols > 0 && dimensions.rows > 0)
}

function dimensionsEqual(
  a: TerminalStartupGridDimensions | null,
  b: TerminalStartupGridDimensions | null
): boolean {
  return a?.cols === b?.cols && a?.rows === b?.rows
}

export function waitForStableStartupGrid(
  options: TerminalStartupGridSettleOptions
): TerminalStartupGridSettleHandle {
  const minFrames = Math.max(1, options.minFrames ?? DEFAULT_MIN_FRAMES)
  const stableFrames = Math.max(1, options.stableFrames ?? DEFAULT_STABLE_FRAMES)
  const maxFrames = Math.max(minFrames, options.maxFrames ?? DEFAULT_MAX_FRAMES)
  let frame = 0
  let stableFrameCount = 0
  let previous: TerminalStartupGridDimensions | null = null
  let latestUsable: TerminalStartupGridDimensions | null = null
  let observedGridChange = false
  let pendingFrame: number | null = null
  let cancelled = false
  let readyFrame = 0
  const usesReadinessGate = options.isReadyToSettle !== undefined

  const settle = (dimensions: TerminalStartupGridDimensions | null): void => {
    if (cancelled) {
      return
    }
    cancelled = true
    pendingFrame = null
    if (options.isAlive()) {
      options.onSettled(dimensions)
    }
  }

  const tick = (): void => {
    pendingFrame = null
    if (cancelled || !options.isAlive()) {
      return
    }

    frame += 1
    const measured = options.measure()
    const readyToSettle = options.isReadyToSettle?.() ?? true
    if (!readyToSettle) {
      previous = null
      stableFrameCount = 0
      observedGridChange = false
      pendingFrame = options.requestFrame(tick)
      return
    }

    readyFrame += 1
    if (usableDimensions(measured)) {
      latestUsable = measured
      if (dimensionsEqual(previous, measured)) {
        stableFrameCount += 1
      } else {
        observedGridChange = previous !== null
        previous = measured
        stableFrameCount = 1
      }
    } else {
      stableFrameCount = 0
    }

    const settleFrame = usesReadinessGate ? readyFrame : frame
    const heldMinimumWindow = settleFrame >= minFrames
    const stableAfterChange =
      (observedGridChange || usesReadinessGate) &&
      heldMinimumWindow &&
      stableFrameCount >= stableFrames
    if ((latestUsable && stableAfterChange) || settleFrame >= maxFrames) {
      settle(latestUsable)
      return
    }

    pendingFrame = options.requestFrame(tick)
  }

  pendingFrame = options.requestFrame(tick)

  return {
    cancel: () => {
      cancelled = true
      if (pendingFrame !== null) {
        options.cancelFrame(pendingFrame)
        pendingFrame = null
      }
    }
  }
}
