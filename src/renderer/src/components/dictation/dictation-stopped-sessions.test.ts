import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { recordStoppedSession, waitForStoppedSession } from './dictation-stopped-sessions'

function refs() {
  return {
    stoppedSessionIdsRef: { current: new Set<string>() },
    stoppedResolversRef: { current: new Map<string, () => void>() }
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
    expect(stoppedSessionIdsRef.current.has('session-1')).toBe(false)
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

  it('consumes an early stopped session without leaving a resolver', async () => {
    const { stoppedSessionIdsRef, stoppedResolversRef } = refs()

    recordStoppedSession('session-1', stoppedSessionIdsRef, stoppedResolversRef)
    await waitForStoppedSession('session-1', stoppedSessionIdsRef, stoppedResolversRef)

    expect(stoppedSessionIdsRef.current.has('session-1')).toBe(false)
    expect(stoppedResolversRef.current.has('session-1')).toBe(false)
  })
})
