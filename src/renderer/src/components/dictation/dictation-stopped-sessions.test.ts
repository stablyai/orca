import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { recordStoppedSession, waitForStoppedSession } from './dictation-stopped-sessions'

function refs() {
  return {
    stoppedSessionIdsRef: { current: new Set<string>() },
    stoppedResolversRef: { current: new Map<string, Set<() => void>>() }
  }
}

describe('dictation stopped sessions', () => {
  beforeEach(() => {
    vi.stubGlobal('window', {
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('resolves and removes a pending stopped resolver', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('window', {
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout
    })
    const { stoppedSessionIdsRef, stoppedResolversRef } = refs()
    let resolved = false

    const wait = waitForStoppedSession('session-1', stoppedSessionIdsRef, stoppedResolversRef).then(
      () => {
        resolved = true
      }
    )

    expect(stoppedResolversRef.current.has('session-1')).toBe(true)

    recordStoppedSession('session-1', stoppedSessionIdsRef, stoppedResolversRef)
    await wait

    expect(resolved).toBe(true)
    expect(stoppedResolversRef.current.has('session-1')).toBe(false)
    expect(stoppedSessionIdsRef.current.has('session-1')).toBe(true)
  })

  it('resolves a waiter registered after a stop that already had waiters at once', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('window', {
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout
    })
    const { stoppedSessionIdsRef, stoppedResolversRef } = refs()
    const early = waitForStoppedSession('session-1', stoppedSessionIdsRef, stoppedResolversRef)
    recordStoppedSession('session-1', stoppedSessionIdsRef, stoppedResolversRef)
    await early

    let lateResolved = false
    void waitForStoppedSession('session-1', stoppedSessionIdsRef, stoppedResolversRef).then(() => {
      lateResolved = true
    })
    await Promise.resolve()

    expect(lateResolved).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('bounds early stopped sessions that are never awaited', () => {
    const { stoppedSessionIdsRef, stoppedResolversRef } = refs()

    for (let i = 0; i < 20; i += 1) {
      recordStoppedSession(`session-${i}`, stoppedSessionIdsRef, stoppedResolversRef)
    }

    expect(stoppedSessionIdsRef.current.size).toBe(16)
    expect(stoppedSessionIdsRef.current.has('session-0')).toBe(false)
    expect(stoppedSessionIdsRef.current.has('session-19')).toBe(true)
  })

  it('resolves every waiter for an early stopped session', async () => {
    const { stoppedSessionIdsRef, stoppedResolversRef } = refs()

    recordStoppedSession('session-1', stoppedSessionIdsRef, stoppedResolversRef)
    await waitForStoppedSession('session-1', stoppedSessionIdsRef, stoppedResolversRef)
    await waitForStoppedSession('session-1', stoppedSessionIdsRef, stoppedResolversRef)

    expect(stoppedResolversRef.current.has('session-1')).toBe(false)
  })

  it('resolves every pending waiter on one stopped event', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('window', {
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout
    })
    const { stoppedSessionIdsRef, stoppedResolversRef } = refs()
    const resolved: string[] = []

    const first = waitForStoppedSession('session-1', stoppedSessionIdsRef, stoppedResolversRef)
    const second = waitForStoppedSession('session-1', stoppedSessionIdsRef, stoppedResolversRef)
    void first.then(() => resolved.push('first'))
    void second.then(() => resolved.push('second'))
    recordStoppedSession('session-1', stoppedSessionIdsRef, stoppedResolversRef)
    await Promise.all([first, second])

    expect(resolved).toEqual(['first', 'second'])
    expect(vi.getTimerCount()).toBe(0)
    expect(stoppedResolversRef.current.has('session-1')).toBe(false)
  })

  it('times out one waiter without dropping another waiter on the same session', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('window', {
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout
    })
    const { stoppedSessionIdsRef, stoppedResolversRef } = refs()

    const first = waitForStoppedSession('session-1', stoppedSessionIdsRef, stoppedResolversRef)
    vi.advanceTimersByTime(600)
    let secondResolved = false
    const second = waitForStoppedSession('session-1', stoppedSessionIdsRef, stoppedResolversRef)
    void second.then(() => {
      secondResolved = true
    })
    vi.advanceTimersByTime(500)
    await first

    expect(stoppedResolversRef.current.get('session-1')?.size).toBe(1)
    recordStoppedSession('session-1', stoppedSessionIdsRef, stoppedResolversRef)
    await second
    expect(secondResolved).toBe(true)
  })
})
