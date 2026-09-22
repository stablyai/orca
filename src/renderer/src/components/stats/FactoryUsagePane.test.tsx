// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '../../store'

const storeMocks = vi.hoisted(() => ({
  refreshRateLimits: vi.fn(),
  openSettingsPage: vi.fn(),
  openSettingsTarget: vi.fn(),
  recordFeatureInteraction: vi.fn()
}))

const mockStoreState: Pick<
  AppState,
  'rateLimits' | 'refreshRateLimits' | 'openSettingsPage' | 'openSettingsTarget' | 'recordFeatureInteraction'
> = {
  rateLimits: {
    claude: null,
    codex: null,
    gemini: null,
    opencodeGo: null,
    kimi: null,
    antigravity: null,
    minimax: null,
    factory: {
      provider: 'factory',
      session: {
        usedPercent: 12.5,
        windowMinutes: 300,
        resetsAt: null,
        resetDescription: '2:30 PM'
      },
      weekly: {
        usedPercent: 40,
        windowMinutes: 10_080,
        resetsAt: null,
        resetDescription: 'Thu 9:00 AM'
      },
      monthly: {
        usedPercent: 66,
        windowMinutes: 43_200,
        resetsAt: null,
        resetDescription: 'Sep 30, 11:00 PM'
      },
      updatedAt: 1,
      error: null,
      status: 'ok'
    },
    grok: null,
    minimaxCookieConfigured: false,
    grokAuthConfigured: false,
    factoryApiKeyConfigured: true,
    claudeTarget: { runtime: 'host', wslDistro: null },
    codexTarget: { runtime: 'host', wslDistro: null },
    inactiveClaudeAccounts: [],
    inactiveCodexAccounts: []
  },
  refreshRateLimits: storeMocks.refreshRateLimits,
  openSettingsPage: storeMocks.openSettingsPage,
  openSettingsTarget: storeMocks.openSettingsTarget,
  recordFeatureInteraction: storeMocks.recordFeatureInteraction
}

vi.mock('../../store', () => ({
  useAppStore: Object.assign(
    (selector: (state: Partial<AppState>) => unknown) => selector(mockStoreState),
    {
      getState: () => mockStoreState
    }
  )
}))

vi.mock('../ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, string>) =>
    values
      ? Object.entries(values).reduce(
        (text, [token, value]) => text.replace(`{{${token}}}`, value),
        fallback
      )
      : fallback
}))

import { FactoryUsagePane } from './FactoryUsagePane'

describe('FactoryUsagePane', () => {
  beforeEach(() => {
    storeMocks.refreshRateLimits.mockResolvedValue(undefined)
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('renders the three quota windows with percents and reset text', () => {
    render(<FactoryUsagePane />)

    expect(screen.getByTestId('factory-usage-pane')).toBeInTheDocument()
    expect(screen.getByText('13%')).toBeInTheDocument()
    expect(screen.getByText('40%')).toBeInTheDocument()
    expect(screen.getByText('66%')).toBeInTheDocument()
    expect(screen.getByText(/Next reset/)).toBeInTheDocument()
  })

  it('handles an absent monthly quota window', () => {
    const original = mockStoreState.rateLimits
    const withoutMonthly = {
      ...original,
      factory: original.factory ? { ...original.factory, monthly: undefined } : null
    } satisfies AppState['rateLimits']
    mockStoreState.rateLimits = withoutMonthly
    try {
      render(<FactoryUsagePane />)

      expect(screen.getByText('13%')).toBeInTheDocument()
      expect(screen.getByText('40%')).toBeInTheDocument()
      expect(screen.getByText('—')).toBeInTheDocument()
    } finally {
      mockStoreState.rateLimits = original
      cleanup()
    }
  })

  it('shows the earliest Factory reset', () => {
    const original = mockStoreState.rateLimits
    const factory = original.factory
    if (!factory?.session || !factory.weekly || !factory.monthly) {
      throw new Error('Factory fixture requires all quota windows')
    }
    const withDistinctResets = {
      ...original,
      factory: {
        ...factory,
        session: { ...factory.session, resetsAt: 300, resetDescription: '5 hours' },
        weekly: { ...factory.weekly, resetsAt: 100, resetDescription: 'Weekly first' },
        monthly: { ...factory.monthly, resetsAt: 200, resetDescription: 'Monthly second' }
      }
    } satisfies AppState['rateLimits']
    mockStoreState.rateLimits = withDistinctResets
    try {
      render(<FactoryUsagePane />)

      expect(screen.getByText('Next reset Weekly first')).toBeInTheDocument()
    } finally {
      mockStoreState.rateLimits = original
      cleanup()
    }
  })

  it('refreshes usage only from the explicit refresh button', async () => {
    const user = userEvent.setup()
    render(<FactoryUsagePane />)

    await user.click(screen.getByRole('button', { name: 'Refresh Factory usage' }))

    expect(storeMocks.refreshRateLimits).toHaveBeenCalledTimes(1)
  })

  it('shows the setup CTA when no Factory key is configured', () => {
    const original = mockStoreState.rateLimits
    const unconfigured = {
      ...original,
      factoryApiKeyConfigured: false,
      factory: null
    } satisfies AppState['rateLimits']
    mockStoreState.rateLimits = unconfigured
    try {
      render(<FactoryUsagePane />)
      expect(screen.getByText('Set up in Accounts')).toBeInTheDocument()
    } finally {
      mockStoreState.rateLimits = original
      cleanup()
    }
  })
})
