// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getStatus: vi.fn(),
  refreshGrokRateLimits: vi.fn()
}))

vi.mock('@/lib/agent-catalog', () => ({
  AgentIcon: () => React.createElement('span', { 'data-testid': 'grok-icon' })
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
      refreshGrokRateLimits: mocks.refreshGrokRateLimits,
      rateLimits: { grok: null }
    })
}))

import { GrokAccountsSection } from './GrokAccountsSection'

describe('GrokAccountsSection', () => {
  beforeEach(() => {
    mocks.getStatus.mockResolvedValue({
      signedIn: true,
      email: 'dev@example.com',
      teamId: null,
      tokenFresh: false,
      error: null
    })
    mocks.refreshGrokRateLimits.mockResolvedValue(undefined)
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { grokAccounts: { getStatus: mocks.getStatus } }
    })
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('explains the host-scoped Grok recovery flow without requiring a chat message', async () => {
    render(<GrokAccountsSection />)

    expect(
      await screen.findByText(
        'Session expired — run grok on the computer running Orca and wait for it to start. If prompted, complete sign-in, then click Refresh usage. No chat message is needed.'
      )
    ).toBeInTheDocument()
    expect(screen.queryByText(/grok login/i)).not.toBeInTheDocument()
  })
})
