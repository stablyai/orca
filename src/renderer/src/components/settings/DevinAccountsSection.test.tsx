// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getStatus: vi.fn(),
  refreshDevinRateLimits: vi.fn(),
  devinUsage: vi.fn<() => unknown>(() => null)
}))

vi.mock('@/lib/agent-catalog', () => ({
  AgentIcon: () => React.createElement('span', { 'data-testid': 'devin-icon' })
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, string>) => {
    let result = fallback
    for (const [key, value] of Object.entries(values ?? {})) {
      result = result.replace(`{{${key}}}`, value)
    }
    return result
  }
}))

vi.mock('../../store', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      refreshDevinRateLimits: mocks.refreshDevinRateLimits,
      settingsSearchQuery: '',
      rateLimits: { devin: mocks.devinUsage() }
    })
}))

import { DevinAccountsSection } from './DevinAccountsSection'

function quotaUsage(): unknown {
  return {
    provider: 'devin',
    session: {
      usedPercent: 42.4,
      windowMinutes: 1440,
      resetsAt: Date.now() + 3_600_000,
      resetDescription: '5:00 PM'
    },
    weekly: {
      usedPercent: 13.6,
      windowMinutes: 10_080,
      resetsAt: Date.now() + 86_400_000,
      resetDescription: 'Mon'
    },
    planType: 'Team',
    updatedAt: Date.now(),
    error: null,
    status: 'ok'
  }
}

describe('DevinAccountsSection', () => {
  beforeEach(() => {
    mocks.getStatus.mockResolvedValue({
      signedIn: true,
      email: 'dev@example.com',
      tokenFresh: true,
      plan: 'Team',
      error: null
    })
    mocks.refreshDevinRateLimits.mockResolvedValue(undefined)
    mocks.devinUsage.mockReturnValue(null)
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { devinAccounts: { getStatus: mocks.getStatus } }
    })
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('labels the daily and weekly quota percentages separately', async () => {
    mocks.devinUsage.mockReturnValue(quotaUsage())

    render(<DevinAccountsSection />)

    expect(await screen.findByText('Daily quota used')).toBeInTheDocument()
    expect(screen.getByText('42%')).toBeInTheDocument()
    expect(screen.getByText('Resets 5:00 PM')).toBeInTheDocument()
    expect(screen.getByText('Weekly quota used')).toBeInTheDocument()
    expect(screen.getByText('14%')).toBeInTheDocument()
    expect(screen.getByText('Resets Mon')).toBeInTheDocument()
  })

  it('shows the plan reported for the signed-in account', async () => {
    mocks.devinUsage.mockReturnValue(quotaUsage())

    render(<DevinAccountsSection />)

    expect(await screen.findByText('Plan: Team')).toBeInTheDocument()
    expect(screen.getByText('dev@example.com')).toBeInTheDocument()
  })

  // Why: an unreported percentage must be stated, never hidden or shown as 0%.
  it('states why usage is unknown instead of hiding the row', async () => {
    mocks.devinUsage.mockReturnValue({
      provider: 'devin',
      session: null,
      weekly: null,
      updatedAt: Date.now(),
      error: 'Devin did not report quota windows for this account',
      status: 'unavailable'
    })

    render(<DevinAccountsSection />)

    expect(
      await screen.findByText('Devin did not report quota windows for this account')
    ).toBeInTheDocument()
    expect(screen.queryByText('0%')).not.toBeInTheDocument()
  })

  it('tells an expired session to run the Devin CLI rather than repeating the raw error', async () => {
    mocks.getStatus.mockResolvedValue({
      signedIn: true,
      email: 'dev@example.com',
      tokenFresh: false,
      plan: null,
      error: 'Devin session expired'
    })
    mocks.devinUsage.mockReturnValue({
      provider: 'devin',
      session: null,
      weekly: null,
      updatedAt: Date.now(),
      error: 'Devin session expired',
      status: 'error'
    })

    render(<DevinAccountsSection />)

    expect(
      await screen.findByText(
        'Session expired. Run devin on the computer running Orca and wait for it to start. If prompted, complete sign-in, then click Refresh usage.'
      )
    ).toBeInTheDocument()
    expect(screen.queryByText('Devin session expired')).not.toBeInTheDocument()
  })

  it('points a signed-out account at devin login', async () => {
    mocks.getStatus.mockResolvedValue({
      signedIn: false,
      email: null,
      tokenFresh: false,
      plan: null,
      error: null
    })

    render(<DevinAccountsSection />)

    expect(await screen.findByText('Not signed in to Devin CLI')).toBeInTheDocument()
    expect(
      screen.getByText('In a terminal, run devin login, then click Refresh usage here.')
    ).toBeInTheDocument()
  })

  it('refreshes usage and re-reads sign-in state when Refresh usage is clicked', async () => {
    mocks.getStatus.mockResolvedValueOnce({
      signedIn: false,
      email: null,
      tokenFresh: false,
      plan: null,
      error: null
    })

    render(<DevinAccountsSection />)
    await screen.findByText('Not signed in to Devin CLI')

    await userEvent.click(screen.getByRole('button', { name: 'Refresh usage' }))

    expect(mocks.refreshDevinRateLimits).toHaveBeenCalledTimes(1)
    expect(await screen.findByText('dev@example.com')).toBeInTheDocument()
  })
})
