// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'

const mocks = vi.hoisted(() => ({
  refreshRateLimits: vi.fn(),
  rateLimits: {
    cursor: null as ProviderRateLimits | null,
    cursorAuthConfigured: false
  }
}))

vi.mock('@/lib/agent-catalog', () => ({
  AgentIcon: () => React.createElement('span', { 'data-testid': 'cursor-icon' })
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

vi.mock('@/hooks/useResetCountdownClock', () => ({
  useResetCountdownClock: () => 0
}))

vi.mock('../../store', () => ({
  useAppStore: (
    selector: (state: {
      refreshRateLimits: typeof mocks.refreshRateLimits
      rateLimits: typeof mocks.rateLimits
      settingsSearchQuery: string
    }) => unknown
  ) =>
    selector({
      refreshRateLimits: mocks.refreshRateLimits,
      rateLimits: mocks.rateLimits,
      settingsSearchQuery: ''
    })
}))

import { CursorAccountsSection } from './CursorAccountsSection'

function cursorUsage(overrides: Partial<ProviderRateLimits> = {}): ProviderRateLimits {
  return {
    provider: 'cursor',
    session: null,
    weekly: null,
    updatedAt: 1,
    error: null,
    status: 'ok',
    ...overrides
  }
}

describe('CursorAccountsSection', () => {
  beforeEach(() => {
    mocks.rateLimits.cursor = null
    mocks.rateLimits.cursorAuthConfigured = false
    mocks.refreshRateLimits.mockResolvedValue(undefined)
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('shows the host-scoped sign-in guidance when Cursor auth is absent', () => {
    render(<CursorAccountsSection />)

    expect(
      screen.getByText('Not signed in — run Cursor or cursor-agent login on this computer')
    ).toBeInTheDocument()
    expect(screen.getByText(/login on this machine/i)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Cursor CLI docs/i })).toHaveAttribute(
      'href',
      'https://cursor.com/docs/cli/overview'
    )
  })

  it('shows signed-in identity, plan, status, and every usage pool', () => {
    mocks.rateLimits.cursorAuthConfigured = true
    mocks.rateLimits.cursor = cursorUsage({
      planType: 'ultra',
      usageMetadata: {
        accountEmail: 'dev@example.com',
        subscriptionStatus: 'active'
      },
      buckets: [
        {
          name: 'Cursor Models',
          usedPercent: 100,
          windowMinutes: 43_200,
          resetsAt: 60_000,
          resetDescription: 'Sep 30'
        },
        {
          name: 'Other Models',
          usedPercent: 42,
          windowMinutes: 43_200,
          resetsAt: null,
          resetDescription: null
        },
        {
          name: 'Grok Bot',
          usedPercent: 12,
          windowMinutes: 7_102,
          resetsAt: null,
          resetDescription: null
        }
      ]
    })

    render(<CursorAccountsSection />)

    expect(screen.getByText('Signed in')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /dev@example.com/i })).toHaveAttribute(
      'href',
      'https://cursor.com/dashboard/spending'
    )
    expect(screen.getByText('Ultra · active')).toBeInTheDocument()
    expect(screen.getByText('Cursor Models')).toBeInTheDocument()
    expect(screen.getByText('Other Models')).toBeInTheDocument()
    expect(screen.getByText('Grok Bot')).toBeInTheDocument()
    expect(screen.getByText('Resets in 1m')).toBeInTheDocument()
    expect(screen.queryByText('Resets Sep 30')).not.toBeInTheDocument()
  })

  it('renders refresh errors and keeps the refresh action available', () => {
    mocks.rateLimits.cursorAuthConfigured = true
    mocks.rateLimits.cursor = cursorUsage({
      status: 'error',
      error: 'Cursor usage refresh failed'
    })

    render(<CursorAccountsSection />)

    expect(screen.getByText('Cursor usage refresh failed')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Refresh usage' }))
    expect(mocks.refreshRateLimits).toHaveBeenCalledOnce()
  })

  it('shows an auth read failure instead of sign-in guidance', () => {
    mocks.rateLimits.cursor = cursorUsage({
      status: 'error',
      error: 'Unable to read Cursor desktop auth'
    })

    render(<CursorAccountsSection />)

    expect(screen.getByText('Refresh failed')).toBeInTheDocument()
    expect(screen.getByText('Unable to read Cursor desktop auth')).toBeInTheDocument()
    expect(
      screen.queryByText('Not signed in — run Cursor or cursor-agent login on this computer')
    ).not.toBeInTheDocument()
  })
})
