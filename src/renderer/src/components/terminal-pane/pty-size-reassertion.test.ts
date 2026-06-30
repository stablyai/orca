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

    expect(calls).toEqual(['fit', 'measure', 'read-applied'])
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
