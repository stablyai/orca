import { afterEach, describe, expect, it, vi } from 'vitest'
import { requestStablePaneFit } from './pane-fit-resize-observer'

type FitPane = Parameters<typeof requestStablePaneFit>[0]

function makePane(
  initialRows: number,
  proposedRows: () => number
): {
  pane: FitPane
  fit: ReturnType<typeof vi.fn>
  terminal: { cols: number; rows: number }
} {
  const terminal = { cols: 138, rows: initialRows }
  const fit = vi.fn(() => {
    terminal.rows = proposedRows()
  })
  const container = {
    getBoundingClientRect: () => ({
      width: 800,
      height: 600,
      top: 0,
      left: 0,
      right: 800,
      bottom: 600,
      x: 0,
      y: 0,
      toJSON: () => ({})
    })
  }
  const pane = {
    container,
    xtermContainer: container,
    terminal,
    fitAddon: {
      proposeDimensions: () => ({ cols: 138, rows: proposedRows() }),
      fit
    },
    pendingObservedFitRafId: null
  } as unknown as FitPane
  return { pane, fit, terminal }
}

describe('requestStablePaneFit one-row echo', () => {
  const frames: FrameRequestCallback[] = []

  afterEach(() => {
    frames.length = 0
    vi.unstubAllGlobals()
  })

  function installFrameQueue(): void {
    frames.length = 0
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback)
      return frames.length
    })
    vi.stubGlobal('cancelAnimationFrame', () => {})
  }

  function flushFrames(): void {
    let guard = 0
    while (frames.length > 0) {
      const callback = frames.shift()
      callback?.(0)
      guard += 1
      if (guard > 20) {
        throw new Error('fit frames did not settle')
      }
    }
  }

  it('fits a stable one-row change once, then refuses the reverse echo', () => {
    installFrameQueue()
    let proposed = 49
    const { pane, fit, terminal } = makePane(50, () => proposed)
    const firstSettled = vi.fn()

    requestStablePaneFit(pane, firstSettled)
    flushFrames()

    expect(fit).toHaveBeenCalledTimes(1)
    expect(terminal.rows).toBe(49)
    expect(firstSettled).toHaveBeenCalledTimes(1)

    proposed = 50
    const echoSettled = vi.fn()
    requestStablePaneFit(pane, echoSettled)
    flushFrames()

    expect(fit).toHaveBeenCalledTimes(1)
    expect(terminal.rows).toBe(49)
    expect(echoSettled).toHaveBeenCalledTimes(1)
  })

  it('still fits a later one-row change after the echo was refused', () => {
    installFrameQueue()
    let proposed = 49
    const { pane, fit, terminal } = makePane(50, () => proposed)

    requestStablePaneFit(pane)
    flushFrames()
    proposed = 50
    requestStablePaneFit(pane)
    flushFrames()
    expect(fit).toHaveBeenCalledTimes(1)

    requestStablePaneFit(pane)
    flushFrames()

    expect(fit).toHaveBeenCalledTimes(2)
    expect(terminal.rows).toBe(50)
  })

  it('still refuses the echo after a measurement that matches the applied row', () => {
    installFrameQueue()
    let proposed = 49
    const { pane, fit, terminal } = makePane(50, () => proposed)

    requestStablePaneFit(pane)
    flushFrames()
    requestStablePaneFit(pane)
    flushFrames()
    expect(fit).toHaveBeenCalledTimes(1)

    proposed = 50
    requestStablePaneFit(pane)
    flushFrames()

    expect(fit).toHaveBeenCalledTimes(1)
    expect(terminal.rows).toBe(49)
  })

  it('still fits a two-row change', () => {
    installFrameQueue()
    const { pane, fit, terminal } = makePane(50, () => 48)

    requestStablePaneFit(pane)
    flushFrames()

    expect(fit).toHaveBeenCalledTimes(1)
    expect(terminal.rows).toBe(48)
  })

  it('does not fit when the proposal already matches the terminal', () => {
    installFrameQueue()
    const { pane, fit } = makePane(50, () => 50)
    const settled = vi.fn()

    requestStablePaneFit(pane, settled)
    flushFrames()

    expect(fit).not.toHaveBeenCalled()
    expect(settled).toHaveBeenCalledTimes(1)
  })
})
