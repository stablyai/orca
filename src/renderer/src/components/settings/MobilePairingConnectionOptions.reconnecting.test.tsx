// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MobileRelayStatusDetail } from '../../../../shared/mobile-relay-status'
import { MobilePairingConnectionOptions } from './MobilePairingConnectionOptions'

vi.mock('../../store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) =>
    selector({
      orcaProfileAuthStatus: {
        activeProfileId: 'profile-1',
        configured: true,
        state: 'connected',
        persistence: 'encrypted'
      },
      connectCurrentOrcaProfile: async () => null,
      fetchOrcaProfileAuthStatus: async () => null
    })
}))

vi.mock('../../i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

describe('MobilePairingConnectionOptions relay reconnecting badge', () => {
  let statusListener: ((detail: MobileRelayStatusDetail) => void) | null

  beforeEach(() => {
    vi.useFakeTimers()
    statusListener = null
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        mobile: {
          getRelayStatus: vi.fn(() => new Promise(() => {})),
          onRelayStatusChanged: vi.fn((listener: (detail: MobileRelayStatusDetail) => void) => {
            statusListener = listener
            return vi.fn()
          })
        }
      }
    })
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  function publish(detail: MobileRelayStatusDetail): void {
    act(() => statusListener?.(detail))
  }

  function advance(ms: number): void {
    act(() => vi.advanceTimersByTime(ms))
  }

  it('shows Reconnecting through a brief blip and never Unavailable', () => {
    render(<MobilePairingConnectionOptions value="automatic" onChange={vi.fn()} />)
    publish({ status: 'registered' })
    publish({ status: 'reconnecting' })
    expect(screen.getByText('Reconnecting')).toBeVisible()

    advance(6_000)
    publish({ status: 'registered' })
    expect(screen.getByText('Ready')).toBeVisible()
    expect(screen.queryByText('Unavailable')).toBeNull()
  })

  it('shows Unavailable once reconnecting outlasts the grace, across repeated events', () => {
    render(<MobilePairingConnectionOptions value="automatic" onChange={vi.fn()} />)
    publish({ status: 'reconnecting' })
    advance(6_000)
    // Each retry attempt republishes reconnecting; the span keeps its start.
    publish({ status: 'reconnecting' })
    advance(3_999)
    expect(screen.getByText('Reconnecting')).toBeVisible()
    advance(1)
    expect(screen.getByText('Unavailable')).toBeVisible()

    publish({ status: 'registered' })
    publish({ status: 'reconnecting' })
    expect(screen.getByText('Reconnecting')).toBeVisible()
  })

  it('shows Unavailable at once for terminal offline', () => {
    render(<MobilePairingConnectionOptions value="automatic" onChange={vi.fn()} />)
    publish({ status: 'offline' })
    expect(screen.getByText('Unavailable')).toBeVisible()
  })
})
