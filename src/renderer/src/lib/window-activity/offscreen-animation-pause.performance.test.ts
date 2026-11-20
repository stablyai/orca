// @vitest-environment happy-dom
// Guards #45773: a sidebar row ref re-attached in one commit (row list re-derived on status updates)
// must keep its observation instead of unobserving and re-observing every mounted row.
import { afterEach, expect, it, vi } from 'vitest'
import { observeOffscreenRow } from './offscreen-animation-pause'

const calls = { observe: 0, unobserve: 0 }

class CountingIntersectionObserver {
  observe(): void {
    calls.observe++
  }
  unobserve(): void {
    calls.unobserve++
  }
  disconnect(): void {}
}

afterEach(() => {
  vi.unstubAllGlobals()
  calls.observe = 0
  calls.unobserve = 0
})

it('keeps one observation across a same-commit ref re-attach', async () => {
  vi.stubGlobal('IntersectionObserver', CountingIntersectionObserver)
  const row = document.createElement('div')

  const releaseFirst = observeOffscreenRow(row)
  releaseFirst()
  const releaseSecond = observeOffscreenRow(row)
  await Promise.resolve()
  expect(calls).toEqual({ observe: 1, unobserve: 0 })

  releaseSecond()
  await Promise.resolve()
  expect(calls).toEqual({ observe: 1, unobserve: 1 })
})
