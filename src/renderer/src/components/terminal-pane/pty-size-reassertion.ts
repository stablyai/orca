export type PtySizeReassertionDimensions = { cols: number; rows: number }

export type PtySizeReassertionOptions = {
  isDisposed: () => boolean
  getPtyId: () => string | null
  isRemotePtyId: (ptyId: string) => boolean
  shouldSuppressDesktopResize: () => boolean
  fit: () => void
  getTerminalDimensions: () => PtySizeReassertionDimensions
  getAppliedSize: (ptyId: string) => Promise<PtySizeReassertionDimensions | null>
  forwardResize: (cols: number, rows: number) => void
}

export type PtySizeReassertion = {
  request: (requestOptions?: { fit?: boolean }) => void
  dispose: () => void
}

function dimensionsAreUsable(dimensions: PtySizeReassertionDimensions): boolean {
  return dimensions.cols > 0 && dimensions.rows > 0
}

function dimensionsMatch(
  left: PtySizeReassertionDimensions | null,
  right: PtySizeReassertionDimensions
): boolean {
  return left !== null && left.cols === right.cols && left.rows === right.rows
}

export function createPtySizeReassertion(options: PtySizeReassertionOptions): PtySizeReassertion {
  let disposed = false
  let inFlight = false
  let pending = false
  let pendingFit = false

  const canQuery = (ptyId: string | null): ptyId is string => {
    if (disposed || options.isDisposed() || !ptyId) {
      return false
    }
    return !options.isRemotePtyId(ptyId) && !options.shouldSuppressDesktopResize()
  }

  const run = (shouldFit: boolean): void => {
    const ptyId = options.getPtyId()
    if (!canQuery(ptyId)) {
      return
    }
    if (shouldFit) {
      options.fit()
    }
    const target = options.getTerminalDimensions()
    if (!dimensionsAreUsable(target)) {
      return
    }
    inFlight = true

    const forwardIfDrifted = (actual: PtySizeReassertionDimensions | null): void => {
      if (options.getPtyId() !== ptyId || !canQuery(ptyId)) {
        return
      }
      // Why: a queued request means a newer layout observation should re-measure
      // before we send this older target back to the PTY.
      if (pending) {
        return
      }
      if (dimensionsMatch(actual, target)) {
        return
      }
      options.forwardResize(target.cols, target.rows)
    }

    void options
      .getAppliedSize(ptyId)
      // Why: when readback is unavailable, one guarded resize is safer than
      // silently leaving the visible desktop pane at an unverified PTY size.
      .then(forwardIfDrifted, () => forwardIfDrifted(null))
      .finally(() => {
        inFlight = false
        if (pending && !disposed) {
          const shouldFitPending = pendingFit
          pending = false
          pendingFit = false
          run(shouldFitPending)
        }
      })
  }

  return {
    request: (requestOptions) => {
      if (disposed || options.isDisposed()) {
        return
      }
      const shouldFit = requestOptions?.fit !== false
      if (inFlight) {
        pending = true
        pendingFit ||= shouldFit
        return
      }
      run(shouldFit)
    },
    dispose: () => {
      disposed = true
      pending = false
      pendingFit = false
    }
  }
}
