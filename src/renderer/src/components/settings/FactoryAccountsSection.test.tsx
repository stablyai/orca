// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getStatus: vi.fn(),
  saveApiKey: vi.fn(),
  clearApiKey: vi.fn(),
  refreshRateLimits: vi.fn()
}))

vi.mock('@/lib/agent-catalog', () => ({
  AgentIcon: () => React.createElement('span', { 'data-testid': 'droid-icon' })
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
      rateLimits: { factory: null, factoryApiKeyConfigured: false }
    })
}))

import { FactoryAccountsSection } from './FactoryAccountsSection'

describe('FactoryAccountsSection', () => {
  beforeEach(() => {
    mocks.getStatus.mockResolvedValue({ configured: false, source: null, error: null })
    mocks.saveApiKey.mockImplementation(async (key: string) => ({
      configured: true,
      source: 'orca',
      error: null,
      savedKey: key
    }))
    mocks.clearApiKey.mockResolvedValue({ configured: false, source: null, error: null })
    mocks.refreshRateLimits.mockResolvedValue(undefined)
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        factoryAccounts: {
          getStatus: mocks.getStatus,
          saveApiKey: mocks.saveApiKey,
          clearApiKey: mocks.clearApiKey
        }
      }
    })
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('explains the API key and env/dotenv sources when unconfigured', async () => {
    render(<FactoryAccountsSection />)

    expect(
      await screen.findByText(
        /Shows 5-hour, weekly, and monthly Factory usage from a Factory API key/
      )
    ).toBeInTheDocument()
    expect(await screen.findByText('No Factory API key')).toBeInTheDocument()
    expect(
      screen.getByText(/Paste a key below, or set FACTORY_API_KEY \/ ~\/.factory\/.env/)
    ).toBeInTheDocument()
  })

  it('saves a pasted key through factoryAccounts.saveApiKey', async () => {
    const user = userEvent.setup()
    render(<FactoryAccountsSection />)

    const input = await screen.findByPlaceholderText('fk-…')
    await user.type(input, 'fk-pasted-key')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(mocks.saveApiKey).toHaveBeenCalledWith('fk-pasted-key')
    expect(await screen.findByText('API key ready')).toBeInTheDocument()
  })

  it('hides Clear when the key comes from env or dotenv', async () => {
    mocks.getStatus.mockResolvedValue({ configured: true, source: 'env', error: null })
    render(<FactoryAccountsSection />)

    expect(await screen.findByText('API key ready')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Clear' })).not.toBeInTheDocument()
  })

  it('shows the droid icon and refresh affordance', async () => {
    render(<FactoryAccountsSection />)

    expect(await screen.findByTestId('droid-icon')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Refresh usage/ })).toBeInTheDocument()
  })
})
