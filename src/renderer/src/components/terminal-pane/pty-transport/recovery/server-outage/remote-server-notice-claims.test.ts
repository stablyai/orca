// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import {
  usePublishRemoteServerNoticeShowing,
  useRemoteServerNoticeClaim,
  useRemoteServerOutageCardInputs,
  useRemoteServerOutageIds,
  useReportRemoteServerPaneRetries
} from './remote-server-notice-claims'
import type { RemoteServerPaneRetries } from './remote-server-pane-retries'

it('keeps the outage clock through a surface handoff and a held card, then releases it', () => {
  const environmentId = 'fixture-server'
  vi.useFakeTimers()
  vi.setSystemTime(10_000)
  try {
    const host = renderHook(
      ({ showing }) => {
        usePublishRemoteServerNoticeShowing(environmentId, showing)
        return {
          ids: useRemoteServerOutageIds(),
          card: useRemoteServerOutageCardInputs(environmentId)
        }
      },
      { initialProps: { showing: false } }
    )
    const mountSurface = (retries: RemoteServerPaneRetries) =>
      renderHook(() => {
        useReportRemoteServerPaneRetries(environmentId, retries)
        return useRemoteServerNoticeClaim(environmentId, true, true)
      })

    const first = mountSurface('latched')
    expect(host.result.current.card).toEqual({
      speaking: true,
      down: true,
      since: 10_000,
      stopped: true
    })
    const retrying = mountSurface('retrying')
    expect(host.result.current.card.stopped).toBe(false)
    retrying.unmount()
    expect(host.result.current.card.stopped).toBe(true)

    host.rerender({ showing: true })
    first.unmount()
    act(() => {
      vi.advanceTimersByTime(10)
    })
    const next = mountSurface('latched')
    expect(next.result.current).toEqual({ quiet: true, showing: true })
    expect(host.result.current.card.since).toBe(10_000)

    next.unmount()
    act(() => {
      vi.advanceTimersByTime(10_000)
    })
    expect(host.result.current.ids).toEqual([environmentId])
    host.rerender({ showing: false })
    act(() => {
      vi.advanceTimersByTime(10_000)
    })
    expect(host.result.current.ids).toEqual([])
    host.unmount()
  } finally {
    vi.useRealTimers()
  }
})
