// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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

  it('does not treat a cached connected status as a successful re-sign-in', async () => {
    useAppStore.setState({ orcaProfileAuthStatus: { ...status, state: 'connected' } })
    render(<UnexpectedSignoutCard />)
    await act(async () => {})
    act(() => useAppStore.setState({ orcaProfileAuthStatus: status }))
    expect(screen.queryByRole('complementary')).not.toBeNull()
    expect(persist).not.toHaveBeenCalled()
  })

  it('waits for hydration before stamping an already recovered session', async () => {
    useAppStore.setState({ persistedUIReady: false })
    render(<UnexpectedSignoutCard />)
    await act(async () => {})
    act(() => useAppStore.setState({ orcaProfileAuthStatus: { ...status, state: 'connected' } }))
    expect(persist).not.toHaveBeenCalled()
    act(() => useAppStore.setState({ persistedUIReady: true }))
    await waitFor(() => expect(persist).toHaveBeenCalledTimes(1))
    act(() => useAppStore.setState({ orcaProfileAuthStatus: { ...status, state: 'connected' } }))
    expect(persist).toHaveBeenCalledTimes(1)
  })

  it('keeps a failed sign-in available without stamping dismissal', async () => {
    useAppStore.setState({ connectCurrentOrcaProfile: vi.fn().mockResolvedValue(undefined) })
    await showCard()
    fireEvent.click(screen.getByRole('button', { name: 'Sign in to Orca' }))
    await act(async () => {})
    expect(screen.queryByRole('complementary')).not.toBeNull()
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

  it('persists X dismissal and stays hidden after remount', async () => {
    await showCard()
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(persist).toHaveBeenCalledWith({ dismissedUnexpectedSignoutVersion: '1.4.197' })
    cleanup()
    render(<UnexpectedSignoutCard />)
    await act(async () => {})
    expect(screen.queryByRole('complementary')).toBeNull()
  })

  it.each(['storage', 'query'])('ignores the %s preview flag in production', async (source) => {
    if (source === 'storage') {
      window.localStorage.setItem('orca-debug-show-signout-card', '1')
    } else {
      window.history.replaceState({}, '', '/?showSignoutCard=1')
    }
    useAppStore.setState({ orcaProfileAuthStatus: { ...status, state: 'local', cloud: undefined } })
    render(<UnexpectedSignoutCard />)
    await act(async () => {})
    expect(screen.queryByRole('complementary')).toBeNull()
    expect(persist).not.toHaveBeenCalled()
  })

  it('dismisses a development preview without writing real dismissal state', async () => {
    vi.stubEnv('DEV', true)
    window.localStorage.setItem('orca-debug-show-signout-card', '1')
    useAppStore.setState({ orcaProfileAuthStatus: { ...status, state: 'local', cloud: undefined } })
    await showCard()
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByRole('complementary')).toBeNull()
    expect(persist).not.toHaveBeenCalled()
  })
})
