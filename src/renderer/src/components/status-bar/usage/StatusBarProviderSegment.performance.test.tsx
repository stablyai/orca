// @vitest-environment happy-dom
import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ProviderRateLimits } from '../../../../../shared/agent-usage/rate-limits/rate-limit-types'
import { ClippedRowProviderSegment } from './StatusBarProviderSegment'

const observers: { callback: IntersectionObserverCallback; node?: Element }[] = []

class FakeIntersectionObserver {
  private readonly entry: { callback: IntersectionObserverCallback; node?: Element }
  constructor(callback: IntersectionObserverCallback) {
    this.entry = { callback }
    observers.push(this.entry)
  }
  observe(node: Element): void {
    this.entry.node = node
  }
  disconnect(): void {
    observers.splice(observers.indexOf(this.entry), 1)
  }
}

function report(isIntersecting: boolean): void {
  act(() => {
    for (const { callback, node } of observers) {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hook reads only isIntersecting and ignores the observer.
      const entry = { isIntersecting, target: node } as IntersectionObserverEntry
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hook never reads its observer argument.
      callback([entry], {} as IntersectionObserver)
    }
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

// Guards PR #44647: clipped status bar chips stayed mounted and kept reset-countdown timers.
it('keeps no countdown wakes for status bar chips clipped out of view', () => {
  const now = Date.now()
  const pool: ProviderRateLimits = {
    provider: 'antigravity',
    status: 'ok',
    error: null,
    updatedAt: now,
    session: null,
    weekly: null,
    buckets: [
      {
        name: 'Pool',
        group: 'Pool',
        usedPercent: 90,
        resetsAt: now + 5 * 3_600_000,
        resetDescription: null,
        windowMinutes: 300
      }
    ]
  }
  const view = render(
    <>
      {Array.from({ length: 10 }, (_, i) => (
        <ClippedRowProviderSegment key={i} p={pool} display="used" mode="compact" />
      ))}
    </>
  )
  report(false)
  expect(vi.getTimerCount()).toBe(0)
  vi.advanceTimersByTime(3_600_000)
  expect(vi.getTimerCount()).toBe(0)

  report(true)
  expect(vi.getTimerCount()).toBe(10)
  view.unmount()
  expect(vi.getTimerCount()).toBe(0)
})
