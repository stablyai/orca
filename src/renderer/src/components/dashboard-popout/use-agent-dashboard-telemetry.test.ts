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
    vi.useFakeTimers({ now: new Date('2026-10-22T12:00:00Z') })
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
})
