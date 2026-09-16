// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getStatus: vi.fn(),
  refreshRateLimits: vi.fn(),
  antigravityUsage: vi.fn<() => unknown>(() => null)
}))

vi.mock('@/lib/agent-catalog', () => ({
  AgentIcon: () => React.createElement('span', { 'data-testid': 'antigravity-icon' })
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
      refreshRateLimits: mocks.refreshRateLimits,
      settingsSearchQuery: '',
      rateLimits: { antigravity: mocks.antigravityUsage() }
    })
}))

import { AntigravityAccountsSection } from './AntigravityAccountsSection'

describe('AntigravityAccountsSection', () => {
  beforeEach(() => {
    mocks.getStatus.mockResolvedValue({
      signedIn: true,
      email: 'dev@example.com',
      tokenFresh: true,
      error: null
    })
    mocks.refreshRateLimits.mockResolvedValue(undefined)
    mocks.antigravityUsage.mockReturnValue(null)
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { antigravityAccounts: { getStatus: mocks.getStatus } }
    })
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('shows the existing Antigravity CLI sign-in', async () => {
    render(<AntigravityAccountsSection />)

    expect(await screen.findByText('dev@example.com')).toBeInTheDocument()
    expect(
      screen.getByText('Signed in. Orca reads the Antigravity CLI session stored on disk.')
    ).toBeInTheDocument()
  })

  it('explains when the CLI is signed in but usage is unavailable', async () => {
    mocks.antigravityUsage.mockReturnValue({
      provider: 'antigravity',
      session: null,
      weekly: null,
      updatedAt: Date.now(),
      error:
        'Antigravity CLI is signed in. Orca could not read a Code Assist quota for this account.',
      status: 'unavailable'
    })

    render(<AntigravityAccountsSection />)

    expect(
      await screen.findByText(
        'Antigravity CLI is signed in. Orca could not read a Code Assist quota for this account.'
      )
    ).toBeInTheDocument()
    expect(screen.queryByText('0%')).not.toBeInTheDocument()
  })

  it('explains when a signed-in refresh returns an error instead of hiding usage', async () => {
    mocks.antigravityUsage.mockReturnValue({
      provider: 'antigravity',
      session: null,
      weekly: null,
      updatedAt: Date.now(),
      error: 'Quota fetch failed (403)',
      status: 'error'
    })

    render(<AntigravityAccountsSection />)

    expect(await screen.findByText('Quota fetch failed (403)')).toBeInTheDocument()
  })

  it('shows named Antigravity quota buckets after a successful refresh', async () => {
    mocks.antigravityUsage.mockReturnValue({
      provider: 'antigravity',
      session: { usedPercent: 17, windowMinutes: 300, resetsAt: null, resetDescription: '2:36 PM' },
      weekly: { usedPercent: 80, windowMinutes: 10080, resetsAt: null, resetDescription: 'Thu' },
      buckets: [
        {
          name: 'Gemini Models · Weekly',
          usedPercent: 80,
          windowMinutes: 10080,
          resetsAt: null,
          resetDescription: 'Thu'
        },
        {
          name: 'Gemini Models · Five hour',
          usedPercent: 17,
          windowMinutes: 300,
          resetsAt: null,
          resetDescription: '2:36 PM'
        }
      ],
      updatedAt: Date.now(),
      error: null,
      status: 'ok'
    })

    render(<AntigravityAccountsSection />)

    expect(await screen.findByText('Gemini Models · Weekly')).toBeInTheDocument()
    expect(screen.getByText('80%')).toBeInTheDocument()
    expect(screen.getByText('Gemini Models · Five hour')).toBeInTheDocument()
    expect(screen.getByText('17%')).toBeInTheDocument()
  })

  it('explains the host-scoped Antigravity recovery flow without requiring a chat message', async () => {
    mocks.getStatus.mockResolvedValue({
      signedIn: true,
      email: 'dev@example.com',
      tokenFresh: false,
      error: null
    })

    render(<AntigravityAccountsSection />)

    expect(
      await screen.findByText(
        'Session expired — run agy on the computer running Orca and wait for it to start. If prompted, complete sign-in, then click Refresh usage. No chat message is needed.'
      )
    ).toBeInTheDocument()
    expect(screen.queryByText(/agy login/i)).not.toBeInTheDocument()
  })
})
