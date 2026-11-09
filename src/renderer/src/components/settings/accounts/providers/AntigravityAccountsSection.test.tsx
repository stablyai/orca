// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AntigravityAccountsSection } from './AntigravityAccountsSection'
import { callAntigravityAccounts } from '@/runtime/provider-accounts/sign-in/runtime-antigravity-accounts-client'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import type { AntigravityAccountState } from '../../../../../../shared/antigravity-account-types'

vi.mock('@/runtime/provider-accounts/sign-in/runtime-antigravity-accounts-client', () => ({
  callAntigravityAccounts: vi.fn(),
  callAntigravityChatSignIn: vi.fn(),
  subscribeAntigravityChatSignIn: vi.fn()
}))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({
  callRuntimeRpc: vi.fn()
}))
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
