// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MobileRelayStatus } from '../../../../shared/mobile-relay-status'
import type { OrcaProfileAuthStatus } from '../../../../shared/orca-profiles'
import { MobilePairingConnectionOptions } from './MobilePairingConnectionOptions'

type MobileRelayStoreState = {
  orcaProfileAuthStatus: OrcaProfileAuthStatus | null
  orcaProfileConnecting: boolean
  connectCurrentOrcaProfile: () => Promise<null>
  fetchOrcaProfileAuthStatus: () => Promise<OrcaProfileAuthStatus | null>
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

describe('MobilePairingConnectionOptions', () => {
  let statusListener: ((status: MobileRelayStatus) => void) | null
  const connect = vi.fn().mockResolvedValue(null)
  const fetchAuthStatus = vi.fn().mockResolvedValue(null)

  beforeEach(() => {
    statusListener = null
    connect.mockClear()
    fetchAuthStatus.mockClear()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        mobile: {
          getRelayStatus: vi.fn().mockResolvedValue({ status: 'registered' }),
          onRelayStatusChanged: vi.fn((listener: (status: MobileRelayStatus) => void) => {
            statusListener = listener
            return vi.fn()
          })
        },
        shell: { openUrl: vi.fn().mockResolvedValue(undefined) }
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
      connectCurrentOrcaProfile: connect,
      fetchOrcaProfileAuthStatus: fetchAuthStatus
    }
  })

  afterEach(() => cleanup())

  it('shows a compact Sign in row when Orca Relay is selected and signed out', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<MobilePairingConnectionOptions value="automatic" onChange={onChange} />)

    expect(screen.getByTestId('anywhere-sign-in-panel')).toBeVisible()
    expect(screen.getByText('Sign in to use Orca Mobile Relay.')).toBeVisible()
    // Why: do not surface build-setup diagnostics in the pairing flow.
    expect(screen.queryByText(/not configured for this build/i)).toBeNull()

    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(onChange).toHaveBeenCalledWith('automatic')
    expect(connect).toHaveBeenCalledOnce()
  })

  it('hides Sign in when local network is selected', () => {
    render(<MobilePairingConnectionOptions value="local-only" onChange={vi.fn()} />)
    expect(screen.queryByTestId('anywhere-sign-in-panel')).toBeNull()
  })

  it('shows Unavailable instead of a dead Sign in on unconfigured builds', () => {
    mocks.state = {
      ...mocks.state,
      orcaProfileAuthStatus: {
        activeProfileId: 'profile-1',
        configured: false,
        state: 'unconfigured',
        persistence: 'none'
      }
    }
    render(<MobilePairingConnectionOptions value="automatic" onChange={vi.fn()} />)

    // No Relay endpoint to sign into — the Sign in CTA must not appear.
    expect(screen.queryByTestId('anywhere-sign-in-panel')).toBeNull()
    expect(screen.queryByRole('button', { name: /Sign in/i })).toBeNull()
    expect(screen.getByTestId('anywhere-unavailable-panel')).toBeVisible()
    expect(screen.getByText('Unavailable')).toBeVisible()
  })

  it('moves selection with the arrow keys as a radiogroup', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<MobilePairingConnectionOptions value="automatic" onChange={onChange} />)

    screen.getByRole('radio', { name: /Orca Relay/i }).focus()
    await user.keyboard('{ArrowDown}')
    expect(onChange).toHaveBeenCalledWith('local-only')
  })

  it('selects a path from the compact list', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<MobilePairingConnectionOptions value="local-only" onChange={onChange} />)

    expect(
      screen.getByText('Phone can be on cellular or any Wi‑Fi. Sign-in required.')
    ).toBeVisible()
    expect(
      screen.getByText('Phone must be on this Wi‑Fi or your Tailscale. No sign-in.')
    ).toBeVisible()

    await user.click(screen.getByRole('radio', { name: /Orca Relay/i }))
    expect(onChange).toHaveBeenCalledWith('automatic')
  })

  it('refreshes auth status when it is missing on mount', () => {
    mocks.state = {
      ...mocks.state,
      orcaProfileAuthStatus: null
    }
    render(<MobilePairingConnectionOptions value="automatic" onChange={vi.fn()} />)
    expect(fetchAuthStatus).toHaveBeenCalledOnce()
    expect(screen.getByTestId('anywhere-sign-in-panel')).toBeVisible()
  })

  it('shows relay status when signed in on Orca Relay', async () => {
    mocks.state = {
      orcaProfileAuthStatus: {
        activeProfileId: 'profile-1',
        configured: true,
        state: 'connected',
        persistence: 'encrypted'
      },
      orcaProfileConnecting: false,
      connectCurrentOrcaProfile: connect,
      fetchOrcaProfileAuthStatus: fetchAuthStatus
    }
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(<MobilePairingConnectionOptions value="automatic" onChange={onChange} />)

    await waitFor(() => expect(screen.getByText('Ready')).toBeVisible())
    expect(screen.queryByTestId('anywhere-sign-in-panel')).toBeNull()

    await user.click(screen.getByRole('radio', { name: /Local network/i }))
    expect(onChange).toHaveBeenCalledWith('local-only')
    statusListener?.('standby')
  })
})
