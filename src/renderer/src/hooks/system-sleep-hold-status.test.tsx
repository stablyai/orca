// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SystemSleepHold } from '../../../shared/computer-awake-mode'
import { useSystemSleepHold } from './system-sleep-hold-status'

const chromeMocks = vi.hoisted(() => ({ paired: false }))

vi.mock('@/lib/desktop-window-chrome', () => ({
  isPairedWebClientWindow: () => chromeMocks.paired
}))

const MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
const LINUX_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36'

let visibility: DocumentVisibilityState = 'visible'

function hold(sleepDisabled: SystemSleepHold['sleepDisabled']): SystemSleepHold {
  return { sleepDisabled, observedAt: Date.now() }
}

function installApi(getSystemSleepHold?: () => Promise<SystemSleepHold>): void {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { agentAwake: getSystemSleepHold ? { getSystemSleepHold } : {} }
  })
}

async function flush(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-22T06:00:00Z'))
  chromeMocks.paired = false
  visibility = 'visible'
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => visibility
  })
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(MAC_UA)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('useSystemSleepHold', () => {
  it('reads on mount and maps yes to system', async () => {
    const read = vi.fn().mockImplementation(() => Promise.resolve(hold('yes')))
    installApi(read)

    const { result } = renderHook(() => useSystemSleepHold())
    await flush()

    expect(read).toHaveBeenCalledTimes(1)
    expect(result.current.state).toBe('system')
  })

  it('maps no to none and unknown to unchecked on macOS only', async () => {
    const read = vi.fn().mockImplementation(() => Promise.resolve(hold('unknown')))
    installApi(read)

    const mac = renderHook(() => useSystemSleepHold())
    await flush()
    expect(mac.result.current.state).toBe('unchecked')
    mac.unmount()

    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(LINUX_UA)
    const linux = renderHook(() => useSystemSleepHold())
    await flush()
    expect(linux.result.current.state).toBe('none')
    linux.unmount()

    read.mockImplementation(() => Promise.resolve(hold('no')))
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(MAC_UA)
    const off = renderHook(() => useSystemSleepHold())
    await flush()
    expect(off.result.current.state).toBe('none')
  })

  it('stays none when the method is absent or the window is a paired web client', async () => {
    installApi()
    const absent = renderHook(() => useSystemSleepHold())
    await flush()
    expect(absent.result.current.state).toBe('none')
    absent.unmount()

    const read = vi.fn().mockImplementation(() => Promise.resolve(hold('yes')))
    installApi(read)
    chromeMocks.paired = true
    const paired = renderHook(() => useSystemSleepHold())
    await flush()
    expect(paired.result.current.state).toBe('none')
    expect(read).not.toHaveBeenCalled()
  })

  it('means unchecked on macOS when the method exists but the read rejects', async () => {
    const read = vi.fn().mockImplementation(() => Promise.reject(new Error('ipc closed')))
    installApi(read)
    const { result } = renderHook(() => useSystemSleepHold())
    await flush()

    expect(read).toHaveBeenCalledTimes(1)
    expect(result.current.state).toBe('unchecked')
  })

  it('means unchecked on macOS when the read never answers', async () => {
    const read = vi.fn().mockImplementation(() => new Promise(() => {}))
    installApi(read)
    const { result } = renderHook(() => useSystemSleepHold())
    await flush()
    expect(result.current.state).toBe('unchecked')

    await advance(10_100)
    expect(result.current.state).toBe('unchecked')
  })

  it('is unchecked on the first render of a Mac with the read pending, then system once it answers yes', async () => {
    let answer: (value: SystemSleepHold) => void = () => {}
    const read = vi.fn().mockImplementation(
      () =>
        new Promise<SystemSleepHold>((resolve) => {
          answer = resolve
        })
    )
    installApi(read)

    const { result } = renderHook(() => useSystemSleepHold())
    await flush()
    expect(read).toHaveBeenCalledTimes(1)
    expect(result.current.state).toBe('unchecked')

    await act(async () => {
      answer(hold('yes'))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(result.current.state).toBe('system')
  })

  it('is none on the first render for a paired web client, an absent method, or a non-Mac host', () => {
    installApi()
    const absent = renderHook(() => useSystemSleepHold())
    expect(absent.result.current.state).toBe('none')
    absent.unmount()

    installApi(vi.fn().mockImplementation(() => new Promise(() => {})))
    chromeMocks.paired = true
    const paired = renderHook(() => useSystemSleepHold())
    expect(paired.result.current.state).toBe('none')
    paired.unmount()

    chromeMocks.paired = false
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(LINUX_UA)
    const linux = renderHook(() => useSystemSleepHold())
    expect(linux.result.current.state).toBe('none')
  })

  it('means unchecked on macOS for an answer that is not a hold', async () => {
    const read = vi.fn().mockImplementation(() => Promise.resolve({ sleepDisabled: 'maybe' }))
    installApi(read)
    const { result } = renderHook(() => useSystemSleepHold())
    await flush()

    expect(result.current.state).toBe('unchecked')
  })

  it('stays none on a non-Mac host when the read rejects', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(LINUX_UA)
    const read = vi.fn().mockImplementation(() => Promise.reject(new Error('ipc closed')))
    installApi(read)
    const { result } = renderHook(() => useSystemSleepHold())
    await flush()

    expect(read).toHaveBeenCalledTimes(1)
    expect(result.current.state).toBe('none')
  })

  it('makes no read for a hidden mount and one read when the window becomes visible', async () => {
    visibility = 'hidden'
    const read = vi.fn().mockImplementation(() => Promise.resolve(hold('yes')))
    installApi(read)

    renderHook(() => useSystemSleepHold())
    await advance(120_000)
    expect(read).not.toHaveBeenCalled()

    visibility = 'visible'
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('polls every 30 s while visible and not at all while hidden', async () => {
    const read = vi.fn().mockImplementation(() => Promise.resolve(hold('no')))
    installApi(read)
    renderHook(() => useSystemSleepHold())
    await flush()
    expect(read).toHaveBeenCalledTimes(1)

    await advance(30_000)
    expect(read).toHaveBeenCalledTimes(2)
    await advance(30_000)
    expect(read).toHaveBeenCalledTimes(3)

    visibility = 'hidden'
    await advance(120_000)
    expect(read).toHaveBeenCalledTimes(3)
  })

  it('reads once per focus and once per menu open when the value is older than 5 s', async () => {
    const read = vi.fn().mockImplementation(() => Promise.resolve(hold('no')))
    installApi(read)
    const { result } = renderHook(() => useSystemSleepHold())
    await flush()
    expect(read).toHaveBeenCalledTimes(1)

    await advance(6_000)
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(read).toHaveBeenCalledTimes(2)

    await advance(6_000)
    await act(async () => {
      result.current.refresh()
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(read).toHaveBeenCalledTimes(3)
  })

  it('sends one read for a focus and a visibilitychange that arrive together', async () => {
    const read = vi.fn().mockImplementation(() => Promise.resolve(hold('no')))
    installApi(read)
    renderHook(() => useSystemSleepHold())
    await flush()
    await advance(6_000)

    await act(async () => {
      window.dispatchEvent(new Event('focus'))
      document.dispatchEvent(new Event('visibilitychange'))
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(read).toHaveBeenCalledTimes(2)
  })

  it('asks again once at expiry when a focus lands inside the cache window', async () => {
    let current: SystemSleepHold['sleepDisabled'] = 'yes'
    const cache: { value: SystemSleepHold | null } = { value: null }
    // Why: stands in for main's 5 s cache, which answers a read inside the window with the old value.
    const read = vi.fn().mockImplementation(() => {
      if (!cache.value || Date.now() - cache.value.observedAt >= 5_000) {
        cache.value = hold(current)
      }
      return Promise.resolve(cache.value)
    })
    installApi(read)
    const { result } = renderHook(() => useSystemSleepHold())
    await flush()
    expect(result.current.state).toBe('system')

    current = 'no'
    await advance(1_000)
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(read).toHaveBeenCalledTimes(1)
    expect(result.current.state).toBe('system')

    await advance(4_100)
    expect(read).toHaveBeenCalledTimes(2)
    expect(result.current.state).toBe('none')
  })

  it('keeps a focus that arrives while a read is in flight and re-asks once for an older value', async () => {
    let calls = 0
    const read = vi.fn().mockImplementation(() => {
      calls += 1
      if (calls === 1) {
        return Promise.resolve(hold('yes'))
      }
      if (calls === 2) {
        const stale = { sleepDisabled: 'yes', observedAt: Date.now() - 3_000 } as const
        return new Promise((resolve) => setTimeout(() => resolve(stale), 200))
      }
      return Promise.resolve(hold('no'))
    })
    installApi(read)
    const { result } = renderHook(() => useSystemSleepHold())
    await advance(30_100)
    expect(read).toHaveBeenCalledTimes(2)

    await act(async () => {
      window.dispatchEvent(new Event('focus'))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(read).toHaveBeenCalledTimes(2)
    await advance(200)
    expect(result.current.state).toBe('system')

    await advance(2_100)
    expect(read).toHaveBeenCalledTimes(3)
    expect(result.current.state).toBe('none')

    await advance(10_000)
    expect(read).toHaveBeenCalledTimes(3)
  })

  it('re-asks once for a read that began before the event and finished after it', async () => {
    let current: SystemSleepHold['sleepDisabled'] = 'yes'
    const read = vi.fn().mockImplementation(() => {
      const answer = { sleepDisabled: current, observedAt: Date.now() }
      return new Promise((resolve) => setTimeout(() => resolve(answer), 300))
    })
    installApi(read)
    const { result } = renderHook(() => useSystemSleepHold())
    await advance(100)
    current = 'no'
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
      await vi.advanceTimersByTimeAsync(0)
    })
    await advance(300)
    expect(result.current.state).toBe('system')
    expect(read).toHaveBeenCalledTimes(1)

    await advance(5_000)
    expect(read).toHaveBeenCalledTimes(2)
    await advance(300)
    expect(result.current.state).toBe('none')

    await advance(10_000)
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('answers two events during one read with a single re-ask for the later one', async () => {
    const t0 = Date.now()
    let calls = 0
    const read = vi.fn().mockImplementation(() => {
      calls += 1
      // Why: the first answer is a probe main began between the two events, so only the later event postdates it.
      const answer =
        calls === 1
          ? { sleepDisabled: 'yes', observedAt: t0 + 200 }
          : { sleepDisabled: 'no', observedAt: Date.now() }
      return new Promise((resolve) => setTimeout(() => resolve(answer), calls === 1 ? 600 : 0))
    })
    installApi(read)
    const { result } = renderHook(() => useSystemSleepHold())
    await advance(100)
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
      await vi.advanceTimersByTimeAsync(0)
    })
    await advance(200)
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
      await vi.advanceTimersByTimeAsync(0)
    })
    await advance(400)
    expect(result.current.state).toBe('system')
    expect(read).toHaveBeenCalledTimes(1)

    await advance(5_000)
    expect(read).toHaveBeenCalledTimes(2)
    expect(result.current.state).toBe('none')

    await advance(10_000)
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('drops a scheduled re-ask once the 30 s poll has already answered the event', async () => {
    const cache: { value: SystemSleepHold | null } = { value: null }
    const read = vi.fn().mockImplementation(() => {
      if (!cache.value || Date.now() - cache.value.observedAt >= 5_000) {
        cache.value = hold('no')
      }
      return Promise.resolve(cache.value)
    })
    installApi(read)
    renderHook(() => useSystemSleepHold())
    await advance(25_000)
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(read).toHaveBeenCalledTimes(2)

    await advance(1_000)
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(read).toHaveBeenCalledTimes(2)

    await advance(4_100)
    expect(read).toHaveBeenCalledTimes(3)
    await advance(10_000)
    expect(read).toHaveBeenCalledTimes(3)
  })

  it('keeps a scheduled re-ask that fires while the 30 s poll is in flight with an older value', async () => {
    let calls = 0
    const read = vi.fn().mockImplementation(() => {
      calls += 1
      if (calls <= 2) {
        return Promise.resolve(hold('yes'))
      }
      if (calls === 3) {
        // Why: the poll gets main's cached value from the focus read, answered late by a busy main.
        const cached = { sleepDisabled: 'yes', observedAt: Date.now() - 4_000 } as const
        return new Promise((resolve) => setTimeout(() => resolve(cached), 2_000))
      }
      return Promise.resolve(hold('no'))
    })
    installApi(read)
    const { result } = renderHook(() => useSystemSleepHold())
    await advance(26_000)
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(read).toHaveBeenCalledTimes(2)

    await advance(1_000)
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
      await vi.advanceTimersByTimeAsync(0)
    })
    await advance(3_000)
    expect(read).toHaveBeenCalledTimes(3)

    await advance(2_100)
    expect(read).toHaveBeenCalledTimes(4)
    expect(result.current.state).toBe('none')

    await advance(20_000)
    expect(read).toHaveBeenCalledTimes(4)
  })

  it('leaves no pending timer when it unmounts during an unresolved read', async () => {
    const read = vi.fn().mockImplementation(() => new Promise(() => {}))
    installApi(read)
    const { unmount } = renderHook(() => useSystemSleepHold())
    await flush()
    expect(read).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBeGreaterThan(0)

    unmount()

    expect(vi.getTimerCount()).toBe(0)
  })

  it('recovers from unchecked on the next poll', async () => {
    const read = vi
      .fn()
      .mockImplementationOnce(() => Promise.resolve(hold('unknown')))
      .mockImplementation(() => Promise.resolve(hold('yes')))
    installApi(read)
    const { result } = renderHook(() => useSystemSleepHold())
    await flush()
    expect(result.current.state).toBe('unchecked')

    await advance(30_000)
    expect(result.current.state).toBe('system')
  })

  it('stops listening after unmount', async () => {
    const read = vi.fn().mockImplementation(() => Promise.resolve(hold('no')))
    installApi(read)
    const { unmount } = renderHook(() => useSystemSleepHold())
    await flush()
    unmount()

    await advance(120_000)
    window.dispatchEvent(new Event('focus'))
    await flush()

    expect(read).toHaveBeenCalledTimes(1)
  })
})
