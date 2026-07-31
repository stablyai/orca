// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getStatus: vi.fn(),
  refreshCursorRateLimits: vi.fn()
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

vi.mock('../../store', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      refreshCursorRateLimits: mocks.refreshCursorRateLimits,
      rateLimits: { cursor: null }
    })
}))

import { CursorAccountsSection } from './CursorAccountsSection'

describe('CursorAccountsSection', () => {
  beforeEach(() => {
    mocks.getStatus.mockResolvedValue({
      signedIn: true,
      email: 'dev@example.com',
      userId: 'user-1',
      tokenFresh: false,
      error: null
    })
    mocks.refreshCursorRateLimits.mockResolvedValue(undefined)
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { cursorAccounts: { getStatus: mocks.getStatus } }
    })
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('explains the host-scoped Cursor recovery flow when the token is stale', async () => {
    render(<CursorAccountsSection />)

    expect(
      await screen.findByText(
        'Session expired — sign in to Cursor on the computer running Orca, then click Refresh usage.'
      )
    ).toBeInTheDocument()
  })
})
