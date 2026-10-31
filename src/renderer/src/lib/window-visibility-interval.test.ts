import { beforeEach, describe, expect, it, vi } from 'vitest'
import { installWindowVisibilityInterval } from './window-visibility-interval'

describe('installWindowVisibilityInterval', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('runs intervals only while the document is visible', () => {
    let visibilityState: DocumentVisibilityState = 'hidden'
    const documentListeners = new Map<string, () => void>()
    const clearIntervalMock = vi.fn()
    const setIntervalMock = vi.fn(() => 1 as unknown as ReturnType<typeof setInterval>)
    const run = vi.fn()

    vi.stubGlobal('window', {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    })
    vi.stubGlobal('document', {
      get visibilityState() {
        return visibilityState
      },
      addEventListener: vi.fn((event: string, listener: () => void) => {
        documentListeners.set(event, listener)
      }),
      removeEventListener: vi.fn()
    })

    const cleanup = installWindowVisibilityInterval({
      run,
      intervalMs: 3000,
      setIntervalFn: setIntervalMock,
      clearIntervalFn: clearIntervalMock
    })

    expect(run).not.toHaveBeenCalled()
    expect(setIntervalMock).not.toHaveBeenCalled()

    visibilityState = 'visible'
    documentListeners.get('visibilitychange')?.()
    expect(run).toHaveBeenCalledTimes(1)
    expect(setIntervalMock).toHaveBeenCalledTimes(1)

    visibilityState = 'hidden'
    documentListeners.get('visibilitychange')?.()
    expect(clearIntervalMock).toHaveBeenCalledWith(1)

    visibilityState = 'visible'
    documentListeners.get('visibilitychange')?.()
    expect(run).toHaveBeenCalledTimes(2)
    expect(setIntervalMock).toHaveBeenCalledTimes(2)

    cleanup()
    expect(document.removeEventListener).toHaveBeenCalledWith(
      'visibilitychange',
      documentListeners.get('visibilitychange')
    )
  })

  it('uses runOnVisible for the becoming-visible run and run for interval ticks', () => {
    let visibilityState: DocumentVisibilityState = 'hidden'
    const documentListeners = new Map<string, () => void>()
    const intervalCallbacks: (() => void)[] = []
    const setIntervalMock = vi.fn((callback: () => void) => {
      intervalCallbacks.push(callback)
      return 1 as unknown as ReturnType<typeof setInterval>
    })
    const run = vi.fn()
    const runOnVisible = vi.fn()

    vi.stubGlobal('window', {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    })
    vi.stubGlobal('document', {
      get visibilityState() {
        return visibilityState
      },
      addEventListener: vi.fn((event: string, listener: () => void) => {
        documentListeners.set(event, listener)
      }),
      removeEventListener: vi.fn()
    })

    const cleanup = installWindowVisibilityInterval({
      run,
      runOnVisible,
      intervalMs: 3000,
      setIntervalFn: setIntervalMock,
      clearIntervalFn: vi.fn()
    })

    visibilityState = 'visible'
    documentListeners.get('visibilitychange')?.()
    expect(runOnVisible).toHaveBeenCalledTimes(1)
    expect(run).not.toHaveBeenCalled()

    intervalCallbacks.at(0)?.()
    expect(run).toHaveBeenCalledTimes(1)
    expect(runOnVisible).toHaveBeenCalledTimes(1)

    cleanup()
  })

  it('starts while visible even when the window is not focused', () => {
    const run = vi.fn()
    const setIntervalMock = vi.fn(() => 1 as unknown as ReturnType<typeof setInterval>)

    vi.stubGlobal('window', {
      hasFocus: vi.fn(() => false)
    })
    vi.stubGlobal('document', {
      visibilityState: 'visible',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    })

    const cleanup = installWindowVisibilityInterval({
      run,
      intervalMs: 3000,
      setIntervalFn: setIntervalMock
    })

    expect(run).toHaveBeenCalledTimes(1)
    expect(setIntervalMock).toHaveBeenCalledTimes(1)
    cleanup()
  })

  it('staggers visibilitychange runs across per-instance jitter delays', async () => {
    vi.useFakeTimers()
    let visibilityState: DocumentVisibilityState = 'hidden'
    const listeners: (() => void)[] = []
    vi.stubGlobal('document', {
      get visibilityState() {
        return visibilityState
      },
      addEventListener: vi.fn((_event: string, listener: () => void) => listeners.push(listener)),
      removeEventListener: vi.fn()
    })
    const runs = [vi.fn(), vi.fn(), vi.fn()]
    const cleanups = runs.map((run, index) =>
      installWindowVisibilityInterval({
        run,
        intervalMs: 10_000,
        jitterOnVisible: true,
        jitterFn: () => [0, 100, 400][index] ?? 0
      })
    )

    visibilityState = 'visible'
    listeners.forEach((listener) => listener())
    expect(runs.map((run) => run.mock.calls.length)).toEqual([0, 0, 0])

    await vi.advanceTimersByTimeAsync(0)
    expect(runs.map((run) => run.mock.calls.length)).toEqual([1, 0, 0])
    await vi.advanceTimersByTimeAsync(99)
    expect(runs.map((run) => run.mock.calls.length)).toEqual([1, 0, 0])
    await vi.advanceTimersByTimeAsync(1)
    expect(runs.map((run) => run.mock.calls.length)).toEqual([1, 1, 0])
    await vi.advanceTimersByTimeAsync(300)
    expect(runs.map((run) => run.mock.calls.length)).toEqual([1, 1, 1])

    cleanups.forEach((cleanup) => cleanup())
    vi.useRealTimers()
  })

  it('does not jitter the install-time first run', () => {
    vi.useFakeTimers()
    const run = vi.fn()
    vi.stubGlobal('document', {
      visibilityState: 'visible',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    })

    const cleanup = installWindowVisibilityInterval({
      run,
      intervalMs: 3000,
      jitterOnVisible: true,
      jitterFn: () => 400
    })

    expect(run).toHaveBeenCalledTimes(1)
    cleanup()
    vi.useRealTimers()
  })

  it('cancels a pending visibility jitter run on cleanup', async () => {
    vi.useFakeTimers()
    let visibilityState: DocumentVisibilityState = 'hidden'
    let visibilityListener: (() => void) | undefined
    const run = vi.fn()
    vi.stubGlobal('document', {
      get visibilityState() {
        return visibilityState
      },
      addEventListener: vi.fn((_event: string, listener: () => void) => {
        visibilityListener = listener
      }),
      removeEventListener: vi.fn()
    })

    const cleanup = installWindowVisibilityInterval({
      run,
      intervalMs: 3000,
      jitterOnVisible: true,
      jitterFn: () => 400
    })
    visibilityState = 'visible'
    visibilityListener?.()
    cleanup()

    await vi.advanceTimersByTimeAsync(400)
    expect(run).not.toHaveBeenCalled()
    vi.useRealTimers()
  })
})
