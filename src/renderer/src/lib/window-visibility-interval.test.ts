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

  it('slows ticks while visible but unfocused and catches up overdue work on focus', async () => {
    vi.useFakeTimers()
    let focused = true
    const windowListeners = new Map<string, () => void>()
    vi.stubGlobal('window', {
      addEventListener: vi.fn((event: string, listener: () => void) => {
        windowListeners.set(event, listener)
      }),
      removeEventListener: vi.fn()
    })
    vi.stubGlobal('document', {
      visibilityState: 'visible',
      hasFocus: () => focused,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    })
    const run = vi.fn()

    const cleanup = installWindowVisibilityInterval({
      run,
      intervalMs: 1000,
      slowWhileUnfocused: true
    })
    expect(run).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(run).toHaveBeenCalledTimes(2)

    focused = false
    await vi.advanceTimersByTimeAsync(3000)
    expect(run).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1000)
    expect(run).toHaveBeenCalledTimes(3)

    await vi.advanceTimersByTimeAsync(1500)
    focused = true
    windowListeners.get('focus')?.()
    expect(run).toHaveBeenCalledTimes(4)

    cleanup()
    vi.useRealTimers()
  })
})
