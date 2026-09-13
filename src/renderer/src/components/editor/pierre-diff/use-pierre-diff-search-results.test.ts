// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { usePierreDiffSearchResults } from './use-pierre-diff-search-results'

const workers: FakeWorker[] = []
class FakeWorker {
  onmessage?: (event: { data: unknown }) => void
  postMessage = vi.fn()
  terminate = vi.fn()
  constructor() {
    workers.push(this)
  }
}
function request(text: string) {
  return {
    text: 'contents',
    query: { text, regex: true, matchCase: false, wholeWord: false },
    replacement: ''
  }
}
function setup() {
  vi.useFakeTimers()
  vi.stubGlobal('Worker', FakeWorker)
  const hook = renderHook(({ input }) => usePierreDiffSearchResults(input), {
    initialProps: { input: request('first') }
  })
  act(() => vi.advanceTimersByTime(120))
  return hook
}
afterEach(() => {
  cleanup()
  workers.length = 0
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

it('terminates abandoned regex work and rejects its late result', () => {
  const hook = setup()
  const first = workers[0]
  hook.rerender({ input: request('second') })
  expect(first.terminate).toHaveBeenCalled()
  act(() => first.onmessage?.({ data: { matches: ['stale'] } }))
  expect(hook.result.current).toBeNull()
  act(() => vi.advanceTimersByTime(120))
  act(() => workers[1].onmessage?.({ data: { matches: [], truncated: false } }))
  expect(hook.result.current).toEqual({ matches: [], truncated: false })
  expect(workers[1].terminate).toHaveBeenCalled()
})

it('terminates a stalled worker and reports a recoverable timeout', () => {
  const hook = setup()
  act(() => vi.advanceTimersByTime(5_000))
  expect(workers[0].terminate).toHaveBeenCalled()
  expect(hook.result.current?.errorCode).toBe('timeout')
})

it('terminates active work on unmount', () => {
  const hook = setup()
  hook.unmount()
  expect(workers[0].terminate).toHaveBeenCalled()
})
