// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MobileRelayStatus } from '../../../../shared/mobile-relay-status'
import type { OrcaProfileAuthStatus } from '../../../../shared/orca-profiles'
import { MobileRelayStatusSection } from './MobileRelayStatusSection'

type MobileRelayStoreState = {
  orcaProfileAuthStatus: OrcaProfileAuthStatus | null
  orcaProfileConnecting: boolean
  connectCurrentOrcaProfile: () => Promise<null>
}

const mocks = vi.hoisted(() => ({
  state: {} as MobileRelayStoreState
}))

vi.mock('../../store', () => ({
  useAppStore: (selector: (state: MobileRelayStoreState) => unknown) => selector(mocks.state)
}))

vi.mock('../../i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

describe('MobileRelayStatusSection', () => {
  let statusListener: ((status: MobileRelayStatus) => void) | null
  const connect = vi.fn().mockResolvedValue(null)

  beforeEach(() => {
    statusListener = null
    connect.mockClear()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        mobile: {
          getRelayStatus: vi.fn().mockResolvedValue({ status: 'registered' }),
          onRelayStatusChanged: vi.fn((listener: (status: MobileRelayStatus) => void) => {
            statusListener = listener
            return vi.fn()
          })
        }
      }
    })
    mocks.state = {
      orcaProfileAuthStatus: {
        activeProfileId: 'profile-1',
        configured: true,
        state: 'local',
        persistence: 'none'
      },
      orcaProfileConnecting: false,
      connectCurrentOrcaProfile: connect
    }
  })

  afterEach(() => cleanup())

  it('keeps direct pairing available while offering desktop sign-in', async () => {
    const user = userEvent.setup()
    render(<MobileRelayStatusSection />)

    expect(
      screen.getByText('LAN and Tailscale pairing still work without an account.')
    ).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(connect).toHaveBeenCalledOnce()
  })

  it('shows live automatic relay status for a signed-in desktop', async () => {
    mocks.state = {
      orcaProfileAuthStatus: {
        activeProfileId: 'profile-1',
        configured: true,
        state: 'connected',
        persistence: 'encrypted'
      },
      orcaProfileConnecting: false,
      connectCurrentOrcaProfile: connect
    }
    render(<MobileRelayStatusSection />)

    await waitFor(() => expect(screen.getByText('Registered')).toBeVisible())
    statusListener?.('offline')
    await waitFor(() => expect(screen.getByText('Offline')).toBeVisible())
    expect(screen.queryByRole('button', { name: 'Sign in' })).not.toBeInTheDocument()
  })
})
