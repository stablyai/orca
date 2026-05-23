import { beforeEach, describe, expect, it, vi } from 'vitest'
import { installWindowVisibilityTimeoutPoller } from './window-visibility-timeout-poller'

describe('installWindowVisibilityTimeoutPoller', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('runs immediately while visible and schedules the next poll after completion', async () => {
    const run = vi.fn().mockResolvedValue(undefined)
    const setTimeoutMock = vi.fn(() => 1 as unknown as ReturnType<typeof setTimeout>)
    const clearTimeoutMock = vi.fn()

    vi.stubGlobal('window', {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    })
    vi.stubGlobal('document', {
      visibilityState: 'visible',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    })

    const cleanup = installWindowVisibilityTimeoutPoller({
      run,
      getDelayMs: () => 3000,
      setTimeoutFn: setTimeoutMock,
      clearTimeoutFn: clearTimeoutMock
    })

    expect(run).toHaveBeenCalledTimes(1)
    await Promise.resolve()
    expect(setTimeoutMock).toHaveBeenCalledWith(expect.any(Function), 3000)

    cleanup()
    expect(clearTimeoutMock).toHaveBeenCalledWith(1)
  })

  it('pauses while hidden and refreshes immediately when visible again', async () => {
    let visibilityState: DocumentVisibilityState = 'hidden'
    const documentListeners = new Map<string, () => void>()
    const run = vi.fn().mockResolvedValue(undefined)
    const setTimeoutMock = vi.fn(() => 1 as unknown as ReturnType<typeof setTimeout>)
    const clearTimeoutMock = vi.fn()

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

    const cleanup = installWindowVisibilityTimeoutPoller({
      run,
      getDelayMs: () => 3000,
      setTimeoutFn: setTimeoutMock,
      clearTimeoutFn: clearTimeoutMock
    })

    expect(run).not.toHaveBeenCalled()
    expect(setTimeoutMock).not.toHaveBeenCalled()

    visibilityState = 'visible'
    documentListeners.get('visibilitychange')?.()
    expect(run).toHaveBeenCalledTimes(1)
    await Promise.resolve()
    expect(setTimeoutMock).toHaveBeenCalledTimes(1)

    visibilityState = 'hidden'
    documentListeners.get('visibilitychange')?.()
    expect(clearTimeoutMock).toHaveBeenCalledWith(1)

    cleanup()
  })

  it('does not overlap focus refreshes while a poll is in flight', async () => {
    const windowListeners = new Map<string, () => void>()
    let resolveRun!: () => void
    const run = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveRun = resolve
        })
    )
    const setTimeoutMock = vi.fn(() => 1 as unknown as ReturnType<typeof setTimeout>)

    vi.stubGlobal('window', {
      addEventListener: vi.fn((event: string, listener: () => void) => {
        windowListeners.set(event, listener)
      }),
      removeEventListener: vi.fn()
    })
    vi.stubGlobal('document', {
      visibilityState: 'visible',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    })

    const cleanup = installWindowVisibilityTimeoutPoller({
      run,
      getDelayMs: () => 3000,
      setTimeoutFn: setTimeoutMock
    })

    expect(run).toHaveBeenCalledTimes(1)
    windowListeners.get('focus')?.()
    expect(run).toHaveBeenCalledTimes(1)

    resolveRun()
    await Promise.resolve()
    expect(setTimeoutMock).toHaveBeenCalledTimes(1)
    cleanup()
  })
})
