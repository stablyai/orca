// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getStatus: vi.fn()
}))

vi.mock('@/lib/agent-catalog', () => ({
  AgentIcon: () => React.createElement('span', { 'data-testid': 'muse-icon' })
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

import { MuseAccountsSection } from './MuseAccountsSection'

describe('MuseAccountsSection', () => {
  beforeEach(() => {
    mocks.getStatus.mockResolvedValue({
      signedIn: true,
      email: 'coder@example.com',
      fullName: 'Code R',
      subscriptionActive: true,
      obtainedVia: 'device_flow',
      error: null
    })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { museAccounts: { getStatus: mocks.getStatus } }
    })
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('shows the signed-in Muse CLI account', async () => {
    render(<MuseAccountsSection />)

    expect(await screen.findByText('coder@example.com')).toBeInTheDocument()
    expect(
      screen.getByText('Signed in. Orca reads the Muse CLI session stored on disk.')
    ).toBeInTheDocument()
  })

  it('guides a signed-out user through muse login', async () => {
    mocks.getStatus.mockResolvedValue({
      signedIn: false,
      email: null,
      fullName: null,
      subscriptionActive: null,
      obtainedVia: null,
      error: null
    })
    render(<MuseAccountsSection />)

    expect(await screen.findByText('Not signed in to Muse CLI')).toBeInTheDocument()
    expect(
      screen.getByText(
        'In a terminal, run muse login and approve the code in your browser, then click Refresh status here.'
      )
    ).toBeInTheDocument()
  })

  it('reloads the status on refresh', async () => {
    render(<MuseAccountsSection />)
    await screen.findByText('coder@example.com')

    fireEvent.click(screen.getByRole('button', { name: 'Refresh status' }))
    expect(await screen.findByText('coder@example.com')).toBeInTheDocument()
    expect(mocks.getStatus).toHaveBeenCalledTimes(2)
  })
})
