// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { useStructuredAgentSessionStopPress } from './use-structured-agent-session-stop-press'

afterEach(() => cleanup())

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined
  let reject: (error: unknown) => void = () => undefined
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('a Stop press read as Stopping', () => {
  it('holds while the request is in flight and clears when it answers', async () => {
    const { result } = renderHook(() => useStructuredAgentSessionStopPress('session-1'))
    const answer = deferred<null>()

    let tracked: Promise<null> = Promise.resolve(null)
    act(() => {
      tracked = result.current.track(() => answer.promise)
    })
    expect(result.current.pressed).toBe(true)

    await act(async () => {
      answer.resolve(null)
      await tracked
    })
    expect(result.current.pressed).toBe(false)
  })

  it('clears when the request fails', async () => {
    const { result } = renderHook(() => useStructuredAgentSessionStopPress('session-1'))
    const answer = deferred<null>()

    let tracked: Promise<null> = Promise.resolve(null)
    act(() => {
      tracked = result.current.track(() => answer.promise)
    })
    await act(async () => {
      answer.reject(new Error('transport closed'))
      await tracked.catch(() => undefined)
    })

    expect(result.current.pressed).toBe(false)
  })

  it("never reads another session's press", () => {
    const { result, rerender } = renderHook(
      ({ sessionId }) => useStructuredAgentSessionStopPress(sessionId),
      { initialProps: { sessionId: 'session-1' } }
    )
    act(() => {
      void result.current.track(() => new Promise<null>(() => undefined))
    })

    rerender({ sessionId: 'session-2' })

    expect(result.current.pressed).toBe(false)
  })
})
