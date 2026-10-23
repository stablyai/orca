// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import type { TelemetryConsentState } from '../../../../shared/telemetry-consent-types'
import { useAppStore } from '@/store'

const { track, getConsentState } = vi.hoisted(() => ({
  track: vi.fn(),
  getConsentState: vi.fn()
}))
vi.mock('@/lib/telemetry', () => ({ track, trackWithResult: track, getConsentState }))

import { useAgentDashboardTelemetry } from './use-agent-dashboard-telemetry'

const initialState = useAppStore.getInitialState()

async function flushConsent(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
  })
}

function publishSavedConsent(optedIn: boolean | null): void {
  useAppStore.setState((state) => ({
    settings: {
      ...(state.settings ?? getDefaultSettings(process.cwd())),
      telemetry: { optedIn, installId: 'test-install', existedBeforeTelemetryRelease: false }
    }
  }))
}

describe('dashboard visible-use telemetry', () => {
  let visibility: DocumentVisibilityState

  beforeEach(() => {
    vi.useFakeTimers()
    track.mockReset().mockResolvedValue(true)
    getConsentState.mockReset().mockResolvedValue({ effective: 'enabled' })
    useAppStore.setState({
      settings: {
        ...getDefaultSettings(process.cwd()),
        telemetry: {
          optedIn: true,
          installId: 'test-install',
          existedBeforeTelemetryRelease: false
        }
      }
    })
    visibility = 'visible'
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility)
  })

  afterEach(() => {
    cleanup()
    useAppStore.setState(initialState, true)
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it.each(['popout', 'in_window'] as const)(
    'observes %s across days without recording another opening',
    async (surface) => {
      vi.setSystemTime(new Date('2026-10-22T12:00:00Z'))
      renderHook(() => useAgentDashboardTelemetry(surface))
      await flushConsent()
      expect(track.mock.calls).toEqual([
        ['agent_dashboard_opened', { surface }],
        ['agent_dashboard_active', { surface }]
      ])

      vi.setSystemTime(new Date('2026-10-23T12:00:00Z'))
      act(() => vi.advanceTimersByTime(60_000))

      expect(track.mock.calls.filter(([event]) => event === 'agent_dashboard_opened')).toHaveLength(
        1
      )
      expect(track.mock.calls.filter(([event]) => event === 'agent_dashboard_active')).toHaveLength(
        2
      )
    }
  )

  it('waits for a hidden window to become visible and pauses again when hidden', async () => {
    visibility = 'hidden'
    const { unmount } = renderHook(() => useAgentDashboardTelemetry('popout'))
    await flushConsent()
    act(() => vi.advanceTimersByTime(60_000))
    expect(track.mock.calls).toEqual([['agent_dashboard_opened', { surface: 'popout' }]])

    visibility = 'visible'
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    expect(track).toHaveBeenLastCalledWith('agent_dashboard_active', { surface: 'popout' })
    expect(track).toHaveBeenCalledTimes(2)

    visibility = 'hidden'
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    act(() => vi.advanceTimersByTime(120_000))
    expect(track).toHaveBeenCalledTimes(2)

    unmount()
    visibility = 'visible'
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    act(() => vi.advanceTimersByTime(120_000))
    expect(track).toHaveBeenCalledTimes(2)
  })

  it('stops observations when the board closes while visible', async () => {
    const { unmount } = renderHook(() => useAgentDashboardTelemetry('in_window'))
    await flushConsent()
    expect(track).toHaveBeenCalledTimes(2)

    unmount()
    act(() => vi.advanceTimersByTime(120_000))

    expect(track).toHaveBeenCalledTimes(2)
  })

  it('retains a confirmed observation across visibility changes and observes the next visible day', async () => {
    vi.setSystemTime(new Date('2026-10-22T12:00:00Z'))
    renderHook(() => useAgentDashboardTelemetry('popout'))
    await flushConsent()

    for (let index = 0; index < 3; index++) {
      visibility = 'hidden'
      act(() => document.dispatchEvent(new Event('visibilitychange')))
      visibility = 'visible'
      act(() => document.dispatchEvent(new Event('visibilitychange')))
      await flushConsent()
    }
    expect(track.mock.calls.filter(([event]) => event === 'agent_dashboard_active')).toHaveLength(1)

    visibility = 'hidden'
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    vi.setSystemTime(new Date('2026-10-24T12:00:00Z'))
    visibility = 'visible'
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    await flushConsent()

    expect(track.mock.calls.filter(([event]) => event === 'agent_dashboard_active')).toHaveLength(2)
    expect(track.mock.calls.filter(([event]) => event === 'agent_dashboard_opened')).toHaveLength(1)
  })

  it('sends only two visible-use observations across 24 hours without rerendering the board', async () => {
    vi.setSystemTime(new Date('2026-10-22T12:00:00Z'))
    let renders = 0
    renderHook(() => {
      renders++
      useAgentDashboardTelemetry('popout')
    })
    await flushConsent()

    act(() => vi.advanceTimersByTime(24 * 60 * 60_000))

    expect(track.mock.calls.filter(([event]) => event === 'agent_dashboard_active')).toHaveLength(2)
    expect(getConsentState).toHaveBeenCalledTimes(1)
    expect(renders).toBe(1)
  })

  it.each(['pending_banner', 'user_opt_out', 'do_not_track', 'orca_disabled', 'ci'] as const)(
    'creates no timer or daily-use attempts while blocked by %s',
    async (reason) => {
      getConsentState.mockResolvedValue(
        reason === 'pending_banner'
          ? { effective: 'pending_banner' }
          : { effective: 'disabled', reason }
      )
      renderHook(() => useAgentDashboardTelemetry('popout'))
      await flushConsent()

      act(() => vi.advanceTimersByTime(24 * 60 * 60_000))

      expect(vi.getTimerCount()).toBe(0)
      expect(track.mock.calls).toEqual([['agent_dashboard_opened', { surface: 'popout' }]])
    }
  )

  it('starts and stops observing on consent broadcasts without counting a new opening', async () => {
    publishSavedConsent(null)
    getConsentState.mockResolvedValue({ effective: 'pending_banner' })
    renderHook(() => useAgentDashboardTelemetry('popout'))
    await flushConsent()
    expect(vi.getTimerCount()).toBe(0)

    getConsentState.mockResolvedValue({ effective: 'enabled' })
    act(() => {
      publishSavedConsent(true)
    })
    await flushConsent()
    expect(vi.getTimerCount()).toBe(1)
    expect(track.mock.calls.filter(([event]) => event === 'agent_dashboard_active')).toHaveLength(1)

    getConsentState.mockResolvedValue({ effective: 'disabled', reason: 'user_opt_out' })
    act(() => {
      publishSavedConsent(false)
    })
    await flushConsent()
    expect(vi.getTimerCount()).toBe(0)
    expect(track.mock.calls.filter(([event]) => event === 'agent_dashboard_opened')).toHaveLength(1)
  })

  it('does not install an observer after closing before the consent read finishes', async () => {
    let resolveConsent: ((value: TelemetryConsentState) => void) | undefined
    getConsentState.mockReturnValue(
      new Promise<TelemetryConsentState>((resolve) => {
        resolveConsent = resolve
      })
    )
    const { unmount } = renderHook(() => useAgentDashboardTelemetry('popout'))
    unmount()

    resolveConsent?.({ effective: 'enabled' })
    await flushConsent()

    expect(vi.getTimerCount()).toBe(0)
    expect(track.mock.calls).toEqual([['agent_dashboard_opened', { surface: 'popout' }]])
  })

  it('retries an unrecorded observation and suppresses same-day ticks after confirmation', async () => {
    let recorded = false
    track.mockImplementation(() => Promise.resolve(recorded))
    renderHook(() => useAgentDashboardTelemetry('popout'))
    await flushConsent()

    recorded = true
    await act(async () => vi.advanceTimersByTimeAsync(60_000))
    await act(async () => vi.advanceTimersByTimeAsync(5 * 60_000))

    expect(track.mock.calls.filter(([event]) => event === 'agent_dashboard_active')).toHaveLength(2)
  })

  it('does not stack IPC requests while an observation is pending', async () => {
    track.mockReturnValue(new Promise(() => {}))
    renderHook(() => useAgentDashboardTelemetry('popout'))
    await flushConsent()

    await act(async () => vi.advanceTimersByTimeAsync(10 * 60_000))

    expect(track.mock.calls.filter(([event]) => event === 'agent_dashboard_active')).toHaveLength(1)
  })

  it('releases timers and visibility listeners after repeated open/close cycles', async () => {
    const added = vi.spyOn(document, 'addEventListener')
    const removed = vi.spyOn(document, 'removeEventListener')
    for (let index = 0; index < 25; index++) {
      const { unmount } = renderHook(() => useAgentDashboardTelemetry('popout'))
      await flushConsent()
      unmount()
    }

    expect(vi.getTimerCount()).toBe(0)
    expect(added.mock.calls.filter(([event]) => event === 'visibilitychange')).toHaveLength(25)
    expect(removed.mock.calls.filter(([event]) => event === 'visibilitychange')).toHaveLength(25)
  })
})
