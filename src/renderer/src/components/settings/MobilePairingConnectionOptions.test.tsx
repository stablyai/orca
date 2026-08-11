// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
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

  it('shows Sign in directly under Orca Relay, above LAN', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<MobilePairingConnectionOptions value="automatic" onChange={onChange} />)

    const relay = screen.getByRole('radio', { name: /Orca Relay/i })
    const lan = screen.getByRole('radio', { name: /^LAN\b/i })
    const signInPanel = screen.getByTestId('anywhere-sign-in-panel')
    const signIn = screen.getByRole('button', { name: 'Sign in for Relay' })
    expect(signInPanel).toBeVisible()
    expect(screen.getByText('Relay only — LAN does not need an account.')).toBeVisible()
    // Why: CTA must sit between Relay and LAN so it is not buried under LAN.
    expect(
      relay.compareDocumentPosition(signInPanel) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(signInPanel.compareDocumentPosition(lan) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // Why: `radiogroup` only permits `radio` children. The panel is layout-only,
    // so it must stay role-less rather than declaring a `group` the group cannot
    // own — and its label must not double-announce the button it wraps.
    const group = screen.getByRole('radiogroup')
    expect(within(group).queryAllByRole('group')).toHaveLength(0)
    expect(within(group).getAllByRole('radio')).toHaveLength(2)
    expect(signInPanel).not.toHaveAttribute('aria-label')
    // Why: do not surface build-setup diagnostics in the pairing flow.
    expect(screen.queryByText(/not configured for this build/i)).toBeNull()

    await user.click(signIn)
    expect(onChange).toHaveBeenCalledWith('automatic')
    expect(connect).toHaveBeenCalledOnce()
  })

  it('hides Sign in when LAN is selected', () => {
    render(<MobilePairingConnectionOptions value="local-only" onChange={vi.fn()} />)
    expect(screen.queryByTestId('anywhere-sign-in-panel')).toBeNull()
    expect(screen.queryByRole('button', { name: /Sign in/i })).toBeNull()
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
    const relay = screen.getByRole('radio', { name: /Orca Relay/i })
    expect(relay).toHaveTextContent('Unavailable')
    expect(relay).toHaveTextContent(/isn’t available in this build/i)
  })

  it('keeps Relay unavailable and unselectable while LAN is selected', async () => {
    mocks.state = {
      ...mocks.state,
      orcaProfileAuthStatus: {
        activeProfileId: 'profile-1',
        configured: false,
        state: 'unconfigured',
        persistence: 'none'
      }
    }
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(<MobilePairingConnectionOptions value="local-only" onChange={onChange} />)

    // Availability follows the build, not the selected path.
    const relay = screen.getByRole('radio', { name: /Orca Relay/i })
    expect(relay).toHaveTextContent('Unavailable')
    expect(relay).toHaveTextContent(/isn’t available in this build/i)
    expect(relay).toHaveAttribute('aria-disabled', 'true')

    await user.click(relay)
    expect(onChange).not.toHaveBeenCalled()

    screen.getByRole('radio', { name: /^LAN\b/i }).focus()
    await user.keyboard('{ArrowUp}')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('moves selection with the arrow keys as a radiogroup', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<MobilePairingConnectionOptions value="automatic" onChange={onChange} />)

    screen.getByRole('radio', { name: /Orca Relay/i }).focus()
    await user.keyboard('{ArrowDown}')
    expect(onChange).toHaveBeenCalledWith('local-only')
  })

  it('does not change path when arrow keys hit the Sign in control', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<MobilePairingConnectionOptions value="automatic" onChange={onChange} />)

    screen.getByRole('button', { name: 'Sign in for Relay' }).focus()
    await user.keyboard('{ArrowDown}')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('selects a path from the compact list', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<MobilePairingConnectionOptions value="local-only" onChange={onChange} />)

    expect(
      screen.getByText('Phone can be on cellular or any Wi‑Fi. Sign-in required for Relay only.')
    ).toBeVisible()
    expect(
      screen.getByText(
        'Phone must be on this Wi‑Fi or connected through Tailscale. No account needed.'
      )
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

    await user.click(screen.getByRole('radio', { name: /^LAN\b/i }))
    expect(onChange).toHaveBeenCalledWith('local-only')
    statusListener?.('standby')
  })

  it('keeps LAN available while Relay is retrying', async () => {
    mocks.state = {
      ...mocks.state,
      orcaProfileAuthStatus: {
        activeProfileId: 'profile-1',
        configured: true,
        state: 'connected',
        persistence: 'encrypted'
      }
    }
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(
      <MobilePairingConnectionOptions
        value="automatic"
        onChange={onChange}
        relayMintFailed
        relayMintRetrying
      />
    )

    expect(screen.getByText('Retrying')).toBeVisible()
    const relay = screen.getByRole('radio', { name: /Orca Relay/i })
    const lan = screen.getByRole('radio', { name: /^LAN\b/i })
    expect(relay).toHaveAttribute('aria-disabled', 'true')
    expect(lan).toHaveAttribute('aria-disabled', 'false')
    await user.click(lan)
    expect(onChange).toHaveBeenCalledWith('local-only')
  })
})
