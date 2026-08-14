// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  login: vi.fn(),
  importAccount: vi.fn(),
  select: vi.fn(),
  rename: vi.fn(),
  remove: vi.fn(),
  fetchInactiveKimi: vi.fn()
}))

vi.mock('@/lib/agent-catalog', () => ({
  AgentIcon: () => React.createElement('span', { 'data-testid': 'kimi-icon' })
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, vars?: { value0?: string }) =>
    fallback.replace('{{value0}}', vars?.value0 ?? '')
}))

vi.mock('../../store', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      settingsSearchQuery: '',
      rateLimits: {
        kimi: {
          provider: 'kimi',
          session: {
            usedPercent: 27,
            windowMinutes: 300,
            resetsAt: null,
            resetDescription: null
          },
          weekly: null,
          updatedAt: 1,
          error: null,
          status: 'ok'
        },
        inactiveKimiAccounts: []
      },
      fetchInactiveKimiAccountUsage: mocks.fetchInactiveKimi,
      usagePercentageDisplay: 'used'
    })
}))

import { KimiAccountsSection } from './KimiAccountsSection'

const account = {
  id: 'account-a',
  label: 'Work',
  managedHomeRuntime: 'host' as const,
  wslDistro: null,
  createdAt: 1,
  updatedAt: 1,
  lastAuthenticatedAt: 1
}

describe('KimiAccountsSection', () => {
  beforeEach(() => {
    mocks.list.mockResolvedValue({ accounts: [account], activeAccountId: 'account-a' })
    mocks.importAccount.mockResolvedValue({ accounts: [account], activeAccountId: 'account-a' })
    mocks.login.mockResolvedValue({ accounts: [account], activeAccountId: 'account-a' })
    mocks.select.mockResolvedValue({ accounts: [account], activeAccountId: null })
    mocks.rename.mockResolvedValue({ accounts: [account], activeAccountId: 'account-a' })
    mocks.remove.mockResolvedValue({ accounts: [], activeAccountId: null })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        kimiAccounts: {
          list: mocks.list,
          login: mocks.login,
          import: mocks.importAccount,
          select: mocks.select,
          rename: mocks.rename,
          remove: mocks.remove
        }
      }
    })
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('shows only the user label and explains the bounded copy scope', async () => {
    render(<KimiAccountsSection />)

    expect(await screen.findByText('Work')).toBeInTheDocument()
    expect(
      screen.getByText(
        'Import config.toml and credentials from an existing Kimi Code home. Sessions and logs stay in the original home.'
      )
    ).toBeInTheDocument()
    expect(document.body.textContent).not.toContain('managedHomePath')
    expect(document.body.textContent).not.toContain('/private/')
    expect(screen.getByText('27% used')).toBeInTheDocument()
    expect(mocks.fetchInactiveKimi).toHaveBeenCalledOnce()
  })

  it('imports an existing home with the required user label', async () => {
    render(<KimiAccountsSection />)
    await screen.findByText('Work')

    fireEvent.change(screen.getByLabelText('Account label'), { target: { value: 'Personal' } })
    fireEvent.click(screen.getByRole('button', { name: 'Choose home…' }))

    await waitFor(() => expect(mocks.importAccount).toHaveBeenCalledWith({ label: 'Personal' }))
  })

  it('disables account actions until the initial list resolves', async () => {
    let resolveList:
      | ((value: { accounts: typeof account[]; activeAccountId: string }) => void)
      | undefined
    mocks.list.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveList = resolve
        })
    )

    render(<KimiAccountsSection />)
    fireEvent.change(screen.getByLabelText('Account label'), { target: { value: 'Personal' } })
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Choose home…' })).toBeDisabled()

    resolveList?.({ accounts: [account], activeAccountId: account.id })
    expect(await screen.findByText('Work')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled()
  })

  it('starts device-code sign-in with the required user label', async () => {
    render(<KimiAccountsSection />)
    await screen.findByText('Work')

    fireEvent.change(screen.getByLabelText('Account label'), { target: { value: 'Personal' } })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))

    await waitFor(() => expect(mocks.login).toHaveBeenCalledWith({ label: 'Personal' }))
  })

  it('requires confirmation before deleting the managed copy', async () => {
    render(<KimiAccountsSection />)
    await screen.findByText('Work')

    fireEvent.click(screen.getByRole('button', { name: 'Remove Kimi account' }))

    expect(screen.getByRole('dialog')).toHaveTextContent(
      'The original home and the system default remain unchanged.'
    )
    expect(mocks.remove).not.toHaveBeenCalled()
  })
})
