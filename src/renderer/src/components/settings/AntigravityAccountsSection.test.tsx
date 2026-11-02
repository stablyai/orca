// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AntigravityAccountsSection } from './AntigravityAccountsSection'
import { callAntigravityAccounts } from '@/runtime/runtime-antigravity-accounts-client'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import type { AntigravityAccountState } from '../../../../shared/antigravity-account-types'

vi.mock('@/runtime/runtime-antigravity-accounts-client', () => ({
  callAntigravityAccounts: vi.fn(),
  callAntigravityChatSignIn: vi.fn(),
  subscribeAntigravityChatSignIn: vi.fn()
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: vi.fn() }))
vi.mock('@/lib/agent-catalog', () => ({ AgentIcon: () => null }))

const state: AntigravityAccountState = {
  accounts: [
    {
      id: 'a',
      email: 'synthetic@example.invalid',
      subject: 'google-subject',
      authMethod: 'consumer',
      createdAt: 1,
      updatedAt: 2
    }
  ],
  activeAccountId: 'a',
  selectedAccountId: 'a',
  currentAccount: {
    email: 'synthetic@example.invalid',
    subject: 'google-subject',
    authMethod: 'consumer',
    identityKnown: true
  }
}
const owner = { kind: 'local' } as const
const target = { runtime: 'host' } as const
const usage = {
  rateLimits: {
    antigravity: {
      provider: 'antigravity',
      session: { usedPercent: 31, windowMinutes: 300, resetsAt: null, resetDescription: null },
      weekly: null,
      updatedAt: 1,
      error: null,
      status: 'ok'
    }
  }
}
const changedState: AntigravityAccountState = {
  ...state,
  activeAccountId: null,
  currentAccount: {
    email: 'second@example.invalid',
    subject: 'other-google-subject',
    authMethod: 'consumer',
    identityKnown: true
  }
}
const unidentifiedState: AntigravityAccountState = {
  accounts: [],
  activeAccountId: null,
  selectedAccountId: null,
  currentAccount: { email: null, subject: null, authMethod: 'consumer', identityKnown: false }
}

beforeEach(() => {
  vi.mocked(callAntigravityAccounts).mockReset().mockResolvedValue(state)
  vi.mocked(callRuntimeRpc).mockReset()
})

afterEach(() => cleanup())

describe('native Antigravity Accounts', () => {
  it.each([
    { owner, target, ownerPlatform: 'win32', windows: true },
    {
      owner: { kind: 'environment', environmentId: 'remote' } as const,
      target,
      ownerPlatform: 'linux',
      windows: false
    },
    { owner, target, ownerPlatform: 'darwin', windows: false },
    { owner, target: { runtime: 'wsl' } as const, ownerPlatform: 'win32', windows: false }
  ])('describes the owning host launch promise (%#)', async ({ windows, ...props }) => {
    vi.mocked(callAntigravityAccounts).mockResolvedValue(changedState)
    render(<AntigravityAccountsSection {...props} label="This host" />)
    await screen.findByText('second@example.invalid')
    if (windows) {
      expect(
        screen.getByText(
          'The host default account changed. Select a saved account to apply it again.'
        )
      ).toBeInTheDocument()
      expect(
        screen.getByText(/Select applies and verifies the host default agy credential/)
      ).toHaveTextContent('Command choices and later account changes are handled by agy.')
      expect(screen.queryByText(/before launching agy/)).toBeNull()
    } else {
      expect(
        screen.getByText(/Select a saved account again before launching agy/)
      ).toBeInTheDocument()
      expect(
        screen.getByText(/Selection applies to new agy sessions on this host/)
      ).toBeInTheDocument()
    }
  })

  it('saves a signed-in account with unknown identity and displays the confirmed account', async () => {
    const save = Promise.withResolvers<AntigravityAccountState>()
    vi.mocked(callAntigravityAccounts)
      .mockResolvedValueOnce(unidentifiedState)
      .mockReturnValueOnce(save.promise)
    render(<AntigravityAccountsSection owner={owner} target={target} label="This device" />)
    await screen.findByText('Signed-in identity unavailable')
    await userEvent.click(screen.getByRole('button', { name: 'Save current account' }))
    expect(screen.getByRole('button', { name: 'Save current account' })).toBeDisabled()
    save.resolve({ ...state, selectedAccountId: null })
    await screen.findByText('Native account')
    expect(screen.getAllByText('synthetic@example.invalid')).toHaveLength(2)
  })

  it.each(['Refresh accounts', 'Save current account'])(
    'hides the previous account quota when %s observes a different native identity',
    async (action) => {
      vi.mocked(callRuntimeRpc).mockResolvedValue(usage)
      render(<AntigravityAccountsSection owner={owner} target={target} label="This device" />)
      await screen.findByText('Native account')
      await userEvent.click(screen.getByRole('button', { name: 'Refresh usage' }))
      await screen.findByText('Session: 31% · Weekly: —')
      vi.mocked(callAntigravityAccounts).mockResolvedValueOnce(changedState)
      await userEvent.click(screen.getByRole('button', { name: action }))
      await screen.findByText('second@example.invalid')
      expect(screen.queryByText('Session: 31% · Weekly: —')).toBeNull()
      await userEvent.click(screen.getByRole('button', { name: 'Refresh accounts' }))
      await screen.findByText('Native account')
      expect(screen.queryByText('Session: 31% · Weekly: —')).toBeNull()
    }
  )

  it.each([
    { change: 'a known identity changes', before: state, after: changedState },
    { change: 'a known identity becomes unknown', before: state, after: unidentifiedState },
    { change: 'an unknown identity becomes known', before: unidentifiedState, after: state },
    {
      change: 'an unidentified account signs out',
      before: unidentifiedState,
      after: { ...unidentifiedState, currentAccount: null }
    },
    {
      change: 'the authentication method changes',
      before: unidentifiedState,
      after: {
        ...unidentifiedState,
        currentAccount: {
          email: null,
          subject: null,
          authMethod: 'enterprise',
          identityKnown: false
        }
      }
    }
  ])('clears previous quota when $change during usage refresh', async ({ before, after }) => {
    vi.mocked(callAntigravityAccounts).mockResolvedValue(before)
    vi.mocked(callRuntimeRpc).mockResolvedValue(usage)
    render(<AntigravityAccountsSection owner={owner} target={target} label="This device" />)
    await screen.findByRole('button', { name: 'Refresh usage' })
    await userEvent.click(screen.getByRole('button', { name: 'Refresh usage' }))
    await screen.findByText('Session: 31% · Weekly: —')
    vi.mocked(callAntigravityAccounts).mockResolvedValueOnce(before).mockResolvedValueOnce(after)
    await userEvent.click(screen.getByRole('button', { name: 'Refresh usage' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('native account changed')
    expect(screen.queryByText('Session: 31% · Weekly: —')).toBeNull()
  })

  it.each(['Refresh accounts', 'Save current account'])(
    'shows unidentified usage until %s rechecks credentials',
    async (action) => {
      vi.mocked(callAntigravityAccounts).mockResolvedValue(unidentifiedState)
      vi.mocked(callRuntimeRpc).mockResolvedValue(usage)
      render(<AntigravityAccountsSection owner={owner} target={target} label="This device" />)
      await screen.findByText('Signed-in identity unavailable')
      await userEvent.click(screen.getByRole('button', { name: 'Refresh usage' }))
      await screen.findByText('Session: 31% · Weekly: —')
      expect(screen.queryByRole('alert')).toBeNull()
      if (action === 'Save current account') {
        vi.mocked(callAntigravityAccounts).mockRejectedValueOnce(new Error('Identity unavailable'))
      }
      await userEvent.click(screen.getByRole('button', { name: action }))
      await waitFor(() => expect(screen.getByRole('button', { name: action })).toBeEnabled())
      expect(screen.queryByText('Session: 31% · Weekly: —')).toBeNull()
    }
  )

  it('shows the native identity and prevents removing the active account', async () => {
    render(<AntigravityAccountsSection owner={owner} target={target} label="This device" />)
    await screen.findByText('Native account')
    expect(screen.getAllByText('synthetic@example.invalid')).toHaveLength(2)
    expect(screen.getByRole('button', { name: 'Remove' }).hasAttribute('disabled')).toBe(true)
  })

  it('keeps account identity visible when quota refresh fails', async () => {
    vi.mocked(callRuntimeRpc).mockRejectedValue(new Error('Quota is unavailable'))
    render(<AntigravityAccountsSection owner={owner} target={target} label="This device" />)
    await screen.findByText('Native account')
    await userEvent.click(screen.getByRole('button', { name: 'Refresh usage' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Quota is unavailable')
    expect(screen.getByText('Native account')).toBeTruthy()
    expect(screen.getAllByText('synthetic@example.invalid')).toHaveLength(2)
  })

  it('forwards the selected owning host and distro, and displays refusal without local fallback', async () => {
    vi.mocked(callAntigravityAccounts).mockRejectedValue(new Error('Unsupported owning distro'))
    render(
      <AntigravityAccountsSection
        owner={{ kind: 'environment', environmentId: 'remote' }}
        target={{ runtime: 'wsl', wslDistro: 'Ubuntu' }}
        label="Remote Ubuntu"
      />
    )
    expect(await screen.findByRole('alert')).toHaveTextContent('Unsupported owning distro')
    expect(callAntigravityAccounts).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'remote' },
      { runtime: 'wsl', wslDistro: 'Ubuntu' },
      'List'
    )
    expect(screen.queryByRole('button', { name: 'Save current account' })).toBeNull()
  })

  it('disables account controls synchronously during a selection and never claims success on conflict', async () => {
    const deferred = Promise.withResolvers<AntigravityAccountState>()
    render(<AntigravityAccountsSection owner={owner} target={target} label="This device" />)
    await screen.findByText('Native account')
    vi.mocked(callAntigravityAccounts).mockReturnValueOnce(deferred.promise)
    await userEvent.click(screen.getByRole('button', { name: 'Selected' }))
    expect(
      screen.getByRole('button', { name: 'Save current account' }).hasAttribute('disabled')
    ).toBe(true)
    deferred.reject(new Error('Native conflict'))
    expect(await screen.findByRole('alert')).toHaveTextContent('Native conflict')
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Save current account' }).hasAttribute('disabled')
      ).toBe(false)
    )
  })

  it('re-reads native identity after an unsuccessful selection rather than retaining stale native state', async () => {
    render(<AntigravityAccountsSection owner={owner} target={target} label="This device" />)
    await screen.findByText('Native account')
    vi.mocked(callAntigravityAccounts)
      .mockRejectedValueOnce(new Error('Readback failed'))
      .mockResolvedValueOnce({ ...state, activeAccountId: null, currentAccount: null })
    await userEvent.click(screen.getByRole('button', { name: 'Selected' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Readback failed')
    expect(screen.queryByText('Native account')).toBeNull()
    expect(screen.getByText(/The native account changed/)).toBeTruthy()
  })
})
