// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { CALM_STATUS_HEALTHY_HOLD_MS } from '../../../../../../../shared/remote-runtime/connection-status/calm-status-reveal'
import { useRemoteServerNoticeClaim } from './remote-server-notice-claims'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

function mountSurface(environmentId: string, down = true, canSpeak = true) {
  return renderHook(() => useRemoteServerNoticeClaim(environmentId, down, canSpeak))
}

it('lets one visible surface per down server show its notice, keeps the rest quiet, and hands off on unmount', () => {
  vi.useFakeTimers()
  vi.setSystemTime(10_000)
  const first = mountSurface('server-x')
  const second = mountSurface('server-x')
  const hidden = mountSurface('server-x', true, false)

  expect(first.result.current).toEqual({ speaks: true, quiet: true, since: 10_000 })
  expect(second.result.current).toEqual({ speaks: false, quiet: true, since: 10_000 })
  expect(hidden.result.current).toEqual({ speaks: false, quiet: true, since: 10_000 })

  vi.setSystemTime(20_000)
  first.unmount()
  // The outage clock survives the handoff, so the notice does not restart its timer.
  expect(second.result.current).toEqual({ speaks: true, quiet: true, since: 10_000 })

  second.unmount()
  hidden.unmount()
  act(() => {
    vi.advanceTimersByTime(CALM_STATUS_HEALTHY_HOLD_MS)
  })
  const later = mountSurface('server-x')
  expect(later.result.current.since).toBe(20_000 + CALM_STATUS_HEALTHY_HOLD_MS)
})

it("gives another server's surfaces their own speaker and leaves a healthy server's panes unquieted", () => {
  const onX = mountSurface('server-x')
  const onY = mountSurface('server-y')
  const healthy = mountSurface('server-z', false)

  expect(onX.result.current.speaks).toBe(true)
  expect(onY.result.current.speaks).toBe(true)
  expect(healthy.result.current).toEqual({ speaks: false, quiet: false, since: null })

  onX.unmount()
  expect(onY.result.current.speaks).toBe(true)
  expect(healthy.result.current.quiet).toBe(false)
})
