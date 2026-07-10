// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '../../store'

const storeMocks = vi.hoisted(() => ({
  refreshGrokRateLimits: vi.fn(),
  openSettingsPage: vi.fn(),
  openSettingsTarget: vi.fn(),
  recordFeatureInteraction: vi.fn()
}))

const mockStoreState = {
  rateLimits: {
    claude: null,
    codex: null,
    gemini: null,
    opencodeGo: null,
    kimi: null,
    antigravity: null,
    minimax: null,
    grok: {
      provider: 'grok',
      session: null,
      weekly: {
        usedPercent: 42,
        windowMinutes: 10_080,
        resetsAt: null,
        resetDescription: 'Tue'
      },
      updatedAt: 1,
      error: null,
      status: 'ok'
    },
    minimaxCookieConfigured: false,
    grokAuthConfigured: true,
    claudeTarget: { runtime: 'host', wslDistro: null },
    codexTarget: { runtime: 'host', wslDistro: null },
    inactiveClaudeAccounts: [],
    inactiveCodexAccounts: []
  },
  refreshGrokRateLimits: storeMocks.refreshGrokRateLimits,
  openSettingsPage: storeMocks.openSettingsPage,
  openSettingsTarget: storeMocks.openSettingsTarget,
  recordFeatureInteraction: storeMocks.recordFeatureInteraction
} satisfies Partial<AppState>

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

import { GrokUsagePane } from './GrokUsagePane'

describe('GrokUsagePane', () => {
  beforeEach(() => {
    storeMocks.refreshGrokRateLimits.mockResolvedValue(undefined)
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('does not refresh all providers just from opening the Grok tab', () => {
    render(<GrokUsagePane />)

    expect(screen.getByTestId('grok-usage-pane')).toBeInTheDocument()
    expect(storeMocks.refreshGrokRateLimits).not.toHaveBeenCalled()
  })

  it('refreshes usage only from the explicit refresh button', async () => {
    const user = userEvent.setup()
    render(<GrokUsagePane />)

    await user.click(screen.getByRole('button', { name: 'Refresh Grok usage' }))

    expect(storeMocks.refreshGrokRateLimits).toHaveBeenCalledTimes(1)
  })
})
