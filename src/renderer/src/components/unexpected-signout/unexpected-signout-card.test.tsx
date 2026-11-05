// @vitest-environment happy-dom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '../../store'
import { getDefaultUIState } from '../../../../shared/constants'
import { UnexpectedSignoutCard } from '../UnexpectedSignoutCard'
import type { OrcaProfileAuthStatus } from '../../../../shared/orca-profiles'

const status: OrcaProfileAuthStatus = {
  activeProfileId: 'profile-1',
  configured: true,
  state: 'reconnect-required',
  persistence: 'none',
  cloud: {
    cloudProfileId: 'cloud-1',
    userId: 'user-1',
    email: 'user@example.com',
    displayName: 'User',
    linkedAt: 0
  }
}
const persist = vi.fn().mockResolvedValue(undefined)

beforeEach(() => {
  vi.stubEnv('DEV', false)
  persist.mockClear()
  window.localStorage.clear()
  window.history.replaceState({}, '', '/')
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      ui: { set: persist },
      updater: { getVersion: vi.fn().mockResolvedValue('1.4.197') }
    }
  })
  useAppStore.setState(useAppStore.getInitialState(), true)
  useAppStore.setState({
    orcaProfileAuthStatus: status,
    persistedUIReady: true,
    fetchOrcaProfileAuthStatus: vi.fn().mockResolvedValue(status)
  })
})
afterEach(() => {
  cleanup()
  vi.unstubAllEnvs()
})

async function showCard(): Promise<void> {
  render(<UnexpectedSignoutCard />)
  await screen.findByRole('complementary')
}

describe('unexpected signout lifecycle', () => {
  it('stamps successful sign-in and never re-arms in the same version', async () => {
    await showCard()
    act(() => useAppStore.setState({ orcaProfileAuthStatus: { ...status, state: 'connected' } }))
    await waitFor(() =>
      expect(persist).toHaveBeenCalledWith({ dismissedUnexpectedSignoutVersion: '1.4.197' })
    )
    act(() => useAppStore.setState({ orcaProfileAuthStatus: status }))
    expect(screen.queryByRole('complementary')).toBeNull()
    cleanup()
    render(<UnexpectedSignoutCard />)
    await act(async () => {})
    expect(screen.queryByRole('complementary')).toBeNull()
    expect(persist).toHaveBeenCalledTimes(1)
  })

  it('records nothing for connected users until the card actually appears', async () => {
    useAppStore.setState({ orcaProfileAuthStatus: { ...status, state: 'connected' } })
    render(<UnexpectedSignoutCard />)
    await act(async () => {})
    expect(persist).not.toHaveBeenCalled()
    act(() => useAppStore.setState({ orcaProfileAuthStatus: status }))
    expect(screen.queryByRole('complementary')).not.toBeNull()
    expect(persist).toHaveBeenCalledTimes(1)
  })

  it('does not consume the notice if auth recovers before hydration finishes', async () => {
    useAppStore.setState({ persistedUIReady: false })
    render(<UnexpectedSignoutCard />)
    await act(async () => {})
    act(() => useAppStore.setState({ orcaProfileAuthStatus: { ...status, state: 'connected' } }))
    act(() => useAppStore.setState({ persistedUIReady: true }))
    expect(screen.queryByRole('complementary')).toBeNull()
    expect(persist).not.toHaveBeenCalled()
  })

  it('never shows or consumes a stale card while the auth read is pending', async () => {
    let finish!: (value: typeof status) => void
    useAppStore.setState({
      fetchOrcaProfileAuthStatus: vi.fn(
        () =>
          new Promise<OrcaProfileAuthStatus>((resolve) => {
            finish = resolve
          })
      )
    })
    render(<UnexpectedSignoutCard />)
    await act(async () => {})
    expect(screen.queryByRole('complementary')).toBeNull()
    expect(persist).not.toHaveBeenCalled()
    await act(async () => {
      const connected = { ...status, state: 'connected' as const }
      useAppStore.setState({ orcaProfileAuthStatus: connected })
      finish(connected)
    })
    expect(screen.queryByRole('complementary')).toBeNull()
    expect(persist).not.toHaveBeenCalled()
  })

  it('retains a reopened dismissal through stale UI sync and a renderer remount', async () => {
    useAppStore.getState().hydratePersistedUI(
      {
        ...getDefaultUIState(),
        dismissedUnexpectedSignoutVersion: '1.4.197'
      },
      'startup'
    )
    render(<UnexpectedSignoutCard />)
    await act(async () => {})
    act(() => useAppStore.getState().hydratePersistedUI(getDefaultUIState()))
    expect(screen.queryByRole('complementary')).toBeNull()
    cleanup()
    render(<UnexpectedSignoutCard />)
    await act(async () => {})
    expect(screen.queryByRole('complementary')).toBeNull()
    expect(persist).not.toHaveBeenCalledWith(
      expect.objectContaining({ dismissedUnexpectedSignoutVersion: expect.anything() })
    )
  })
})
