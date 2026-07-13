import { describe, expect, it, vi } from 'vitest'
import { createPtySizeReassertion } from './pty-size-reassertion'

async function flushAsyncTicks(count = 3): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await Promise.resolve()
  }
}

describe('createPtySizeReassertion', () => {
  it('forwards the measured terminal size when the applied PTY size drifted', async () => {
    const forwardResize = vi.fn()
    const reassertion = createPtySizeReassertion({
      isDisposed: () => false,
      getPtyId: () => 'pty-1',
      isRemotePtyId: () => false,
      shouldSuppressDesktopResize: () => false,
      fit: vi.fn(),
      getTerminalDimensions: () => ({ cols: 82, rows: 30 }),
      getAppliedSize: vi.fn(async () => ({ cols: 120, rows: 30 })),
      forwardResize
    })

    reassertion.request()
    await flushAsyncTicks()

    expect(forwardResize).toHaveBeenCalledWith(82, 30)
  })

  it('does not forward when the applied PTY size already matches xterm', async () => {
    const forwardResize = vi.fn()
    const reassertion = createPtySizeReassertion({
      isDisposed: () => false,
      getPtyId: () => 'pty-1',
      isRemotePtyId: () => false,
      shouldSuppressDesktopResize: () => false,
      fit: vi.fn(),
      getTerminalDimensions: () => ({ cols: 82, rows: 30 }),
      getAppliedSize: vi.fn(async () => ({ cols: 82, rows: 30 })),
      forwardResize
    })

    reassertion.request()
    await flushAsyncTicks()

    expect(forwardResize).not.toHaveBeenCalled()
  })

  it('fits and reads xterm dimensions before reading the applied PTY size', async () => {
    const calls: string[] = []
    const reassertion = createPtySizeReassertion({
      isDisposed: () => false,
      getPtyId: () => 'pty-1',
      isRemotePtyId: () => false,
      shouldSuppressDesktopResize: () => false,
      fit: vi.fn(() => {
        calls.push('fit')
      }),
      getTerminalDimensions: vi.fn(() => {
        calls.push('measure')
        return { cols: 82, rows: 30 }
      }),
      getAppliedSize: vi.fn(async () => {
        calls.push('read-applied')
        return { cols: 82, rows: 30 }
      }),
      forwardResize: vi.fn()
    })

    reassertion.request()
    await flushAsyncTicks()

    // The trailing measure is the resolve-time staleness check.
    expect(calls).toEqual(['fit', 'measure', 'read-applied', 'measure'])
  })

  it('does not duplicate the resize when fit already triggered xterm onResize', async () => {
    const forwardResize = vi.fn()
    const reassertion = createPtySizeReassertion({
      isDisposed: () => false,
      getPtyId: () => 'pty-1',
      isRemotePtyId: () => false,
      shouldSuppressDesktopResize: () => false,
      fit: vi.fn(() => {
        forwardResize(82, 30)
      }),
      getTerminalDimensions: () => ({ cols: 82, rows: 30 }),
      getAppliedSize: vi.fn(async () => ({ cols: 82, rows: 30 })),
      forwardResize
    })

    reassertion.request()
    await flushAsyncTicks()

    expect(forwardResize).toHaveBeenCalledTimes(1)
    expect(forwardResize).toHaveBeenCalledWith(82, 30)
  })

  it('can verify current dimensions without fitting again', async () => {
    const fit = vi.fn()
    const forwardResize = vi.fn()
    const reassertion = createPtySizeReassertion({
      isDisposed: () => false,
      getPtyId: () => 'pty-1',
      isRemotePtyId: () => false,
      shouldSuppressDesktopResize: () => false,
      fit,
      getTerminalDimensions: () => ({ cols: 82, rows: 30 }),
      getAppliedSize: vi.fn(async () => ({ cols: 120, rows: 30 })),
      forwardResize
    })

    reassertion.request({ fit: false })
    await flushAsyncTicks()

    expect(fit).not.toHaveBeenCalled()
    expect(forwardResize).toHaveBeenCalledWith(82, 30)
  })

  it('skips remote and suppressed PTYs', async () => {
    const getAppliedSize = vi.fn(async () => ({ cols: 120, rows: 30 }))
    const remote = createPtySizeReassertion({
      isDisposed: () => false,
      getPtyId: () => 'remote:terminal-1',
      isRemotePtyId: () => true,
      shouldSuppressDesktopResize: () => false,
      fit: vi.fn(),
      getTerminalDimensions: () => ({ cols: 82, rows: 30 }),
      getAppliedSize,
      forwardResize: vi.fn()
    })
    const suppressed = createPtySizeReassertion({
      isDisposed: () => false,
      getPtyId: () => 'pty-1',
      isRemotePtyId: () => false,
      shouldSuppressDesktopResize: () => true,
      fit: vi.fn(),
      getTerminalDimensions: () => ({ cols: 82, rows: 30 }),
      getAppliedSize,
      forwardResize: vi.fn()
    })

    remote.request()
    suppressed.request()
    await flushAsyncTicks()

    expect(getAppliedSize).not.toHaveBeenCalled()
  })

  it('coalesces overlapping requests and runs again after an in-flight check resolves', async () => {
    let resolveFirst: (value: { cols: number; rows: number }) => void = () => {}
    const getAppliedSize = vi
      .fn<() => Promise<{ cols: number; rows: number } | null>>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve
          })
      )
      .mockResolvedValue({ cols: 120, rows: 30 })
    const forwardResize = vi.fn()
    const reassertion = createPtySizeReassertion({
      isDisposed: () => false,
      getPtyId: () => 'pty-1',
      isRemotePtyId: () => false,
      shouldSuppressDesktopResize: () => false,
      fit: vi.fn(),
      getTerminalDimensions: () => ({ cols: 82, rows: 30 }),
      getAppliedSize,
      forwardResize
    })

    reassertion.request()
    reassertion.request()
    reassertion.request()
    reassertion.request()
    expect(getAppliedSize).toHaveBeenCalledTimes(1)

    resolveFirst({ cols: 120, rows: 30 })
    await flushAsyncTicks()

    expect(getAppliedSize).toHaveBeenCalledTimes(2)
    expect(forwardResize).toHaveBeenCalledTimes(1)
  })

  it('does not forward a stale target when a newer request is pending', async () => {
    let targetCols = 100
    let resolveFirst: (value: { cols: number; rows: number }) => void = () => {}
    const getAppliedSize = vi
      .fn<() => Promise<{ cols: number; rows: number } | null>>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve
          })
      )
      .mockResolvedValue({ cols: 90, rows: 40 })
    const forwardResize = vi.fn()
    const reassertion = createPtySizeReassertion({
      isDisposed: () => false,
      getPtyId: () => 'pty-1',
      isRemotePtyId: () => false,
      shouldSuppressDesktopResize: () => false,
      fit: vi.fn(),
      getTerminalDimensions: () => ({ cols: targetCols, rows: 40 }),
      getAppliedSize,
      forwardResize
    })

    reassertion.request()
    targetCols = 120
    reassertion.request()
    resolveFirst({ cols: 120, rows: 40 })
    await flushAsyncTicks()

    expect(forwardResize).toHaveBeenCalledTimes(1)
    expect(forwardResize).toHaveBeenCalledWith(120, 40)
    expect(forwardResize).not.toHaveBeenCalledWith(100, 40)
  })

  it('suppresses a stale forward when xterm was refit while the read was in flight', async () => {
    // Regression: a reveal-time fit (or snapshot-restore xterm resize) changes
    // the grid after the target was captured, with no second request() to
    // guard it. The resolved callback must not resize the PTY back to the
    // pre-reveal grid.
    let dims = { cols: 80, rows: 24 }
    let resolveRead: (value: { cols: number; rows: number }) => void = () => {}
    const getAppliedSize = vi
      .fn<() => Promise<{ cols: number; rows: number } | null>>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveRead = resolve
          })
      )
      .mockResolvedValue({ cols: 145, rows: 78 })
    const forwardResize = vi.fn()
    const reassertion = createPtySizeReassertion({
      isDisposed: () => false,
      getPtyId: () => 'pty-1',
      isRemotePtyId: () => false,
      shouldSuppressDesktopResize: () => false,
      fit: vi.fn(),
      getTerminalDimensions: () => dims,
      getAppliedSize,
      forwardResize
    })

    reassertion.request({ fit: false })
    dims = { cols: 145, rows: 78 }
    resolveRead({ cols: 145, rows: 78 })
    await flushAsyncTicks()

    expect(forwardResize).not.toHaveBeenCalledWith(80, 24)
    expect(forwardResize).not.toHaveBeenCalled()
  })

  it('re-runs against the fresh grid when the PTY kept the old size across a mid-flight refit', async () => {
    let dims = { cols: 80, rows: 24 }
    let resolveRead: (value: { cols: number; rows: number }) => void = () => {}
    const getAppliedSize = vi
      .fn<() => Promise<{ cols: number; rows: number } | null>>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveRead = resolve
          })
      )
      .mockResolvedValue({ cols: 80, rows: 24 })
    const forwardResize = vi.fn()
    const reassertion = createPtySizeReassertion({
      isDisposed: () => false,
      getPtyId: () => 'pty-1',
      isRemotePtyId: () => false,
      shouldSuppressDesktopResize: () => false,
      fit: vi.fn(),
      getTerminalDimensions: () => dims,
      getAppliedSize,
      forwardResize
    })

    reassertion.request({ fit: false })
    dims = { cols: 145, rows: 78 }
    resolveRead({ cols: 80, rows: 24 })
    await flushAsyncTicks()

    expect(getAppliedSize).toHaveBeenCalledTimes(2)
    expect(forwardResize).toHaveBeenCalledTimes(1)
    expect(forwardResize).toHaveBeenCalledWith(145, 78)
  })

  it('keeps a single read in flight and converges when the grid oscillates across resolves', async () => {
    // Why: a flapping layout (competing fitters) must not amplify into more
    // than one concurrent readback, and the re-run chain must stop as soon as
    // the grid holds still for one read.
    const grids = [
      { cols: 80, rows: 24 },
      { cols: 145, rows: 78 },
      { cols: 80, rows: 24 },
      { cols: 100, rows: 40 }
    ]
    let readCount = 0
    let dims = grids[0]
    const getAppliedSize = vi.fn(async () => {
      readCount += 1
      // The grid moves during each of the first three flights, then settles.
      dims = grids[Math.min(readCount, grids.length - 1)]
      return { cols: 100, rows: 40 }
    })
    const forwardResize = vi.fn()
    const reassertion = createPtySizeReassertion({
      isDisposed: () => false,
      getPtyId: () => 'pty-1',
      isRemotePtyId: () => false,
      shouldSuppressDesktopResize: () => false,
      fit: vi.fn(),
      getTerminalDimensions: () => dims,
      getAppliedSize,
      forwardResize
    })

    reassertion.request({ fit: false })
    await flushAsyncTicks(20)

    // One re-run per moved-grid flight, then convergence: applied 100x40
    // matches the settled grid, so nothing is forwarded.
    expect(getAppliedSize).toHaveBeenCalledTimes(4)
    expect(forwardResize).not.toHaveBeenCalled()
  })

  it('does not forward a stale target when the readback fails after a mid-flight refit', async () => {
    let dims = { cols: 80, rows: 24 }
    let rejectRead: (reason: Error) => void = () => {}
    const getAppliedSize = vi
      .fn<() => Promise<{ cols: number; rows: number } | null>>()
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectRead = reject
          })
      )
      .mockRejectedValue(new Error('unavailable'))
    const forwardResize = vi.fn()
    const reassertion = createPtySizeReassertion({
      isDisposed: () => false,
      getPtyId: () => 'pty-1',
      isRemotePtyId: () => false,
      shouldSuppressDesktopResize: () => false,
      fit: vi.fn(),
      getTerminalDimensions: () => dims,
      getAppliedSize,
      forwardResize
    })

    reassertion.request({ fit: false })
    dims = { cols: 145, rows: 78 }
    rejectRead(new Error('unavailable'))
    await flushAsyncTicks()

    expect(forwardResize).not.toHaveBeenCalledWith(80, 24)
    // The unguarded fallback resize still happens, but at the fresh grid.
    expect(forwardResize).toHaveBeenCalledWith(145, 78)
  })

  it('forwards once when applied-size readback fails', async () => {
    const forwardResize = vi.fn()
    const reassertion = createPtySizeReassertion({
      isDisposed: () => false,
      getPtyId: () => 'pty-1',
      isRemotePtyId: () => false,
      shouldSuppressDesktopResize: () => false,
      fit: vi.fn(),
      getTerminalDimensions: () => ({ cols: 82, rows: 30 }),
      getAppliedSize: vi.fn(async () => {
        throw new Error('unavailable')
      }),
      forwardResize
    })

    reassertion.request()
    await flushAsyncTicks()

    expect(forwardResize).toHaveBeenCalledTimes(1)
    expect(forwardResize).toHaveBeenCalledWith(82, 30)
  })
})
