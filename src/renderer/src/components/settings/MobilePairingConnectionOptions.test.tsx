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
      connectCurrentOrcaProfile: connect
    }
  })

  afterEach(() => cleanup())

  it('offers local-only pairing while Relay requires sign-in', async () => {
    const user = userEvent.setup()
    render(<MobilePairingConnectionOptions value="local-only" onChange={vi.fn()} />)

    expect(screen.getByRole('switch', { name: /connect with Orca Relay/i })).toBeDisabled()
    expect(screen.getByRole('switch', { name: /connect with Orca Relay/i })).not.toBeChecked()
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(connect).toHaveBeenCalledOnce()
  })

  it('selects either automatic fallback or local-only pairing when signed in', async () => {
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
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(<MobilePairingConnectionOptions value="automatic" onChange={onChange} />)

    await waitFor(() => expect(screen.getByText('Ready')).toBeVisible())
    expect(screen.getByRole('switch', { name: /connect with Orca Relay/i })).toBeChecked()
    await user.click(screen.getByRole('switch', { name: /connect with Orca Relay/i }))
    expect(onChange).toHaveBeenCalledWith('local-only')
    statusListener?.('standby')
    await waitFor(() => expect(screen.getByText('Available')).toBeVisible())
  })

  it('shows the Relay beta availability inline and opens both compatible mobile builds', async () => {
    const user = userEvent.setup()
    render(<MobilePairingConnectionOptions value="local-only" onChange={vi.fn()} />)

    expect(screen.getByText('Beta')).toBeVisible()
    expect(screen.getByText('Available on')).toBeVisible()

    await user.click(screen.getByRole('button', { name: 'TestFlight' }))
    expect(window.api.shell.openUrl).toHaveBeenCalledWith(
      'https://testflight.apple.com/join/YjeGMQBA'
    )

    await user.click(screen.getByRole('button', { name: 'Android APK' }))
    expect(window.api.shell.openUrl).toHaveBeenCalledWith(
      'https://github.com/stablyai/orca/releases/download/mobile-android-v0.0.27/app-release.apk'
    )
  })

  it('keeps the compact onboarding choices structurally stable across modes', async () => {
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
    const props = { compact: true, onChange: vi.fn() }
    const { rerender } = render(<MobilePairingConnectionOptions {...props} value="automatic" />)

    expect(screen.getByRole('switch', { name: /connect with Orca Relay/i })).toBeChecked()
    expect(screen.getByText(/direct connection when available/i)).toBeVisible()
    expect(screen.queryByText('Ready')).toBeNull()

    rerender(<MobilePairingConnectionOptions {...props} value="local-only" />)
    expect(screen.getByRole('switch', { name: /connect with Orca Relay/i })).not.toBeChecked()
    expect(screen.getByText(/direct connection when available/i)).toBeVisible()
    expect(screen.queryByText(/without connecting this phone through Orca Relay/i)).toBeNull()
  })
})
