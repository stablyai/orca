// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '../../store'

const storeMocks = vi.hoisted(() => ({
  refreshCursorRateLimits: vi.fn(),
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
    grok: null,
    cursor: {
      provider: 'cursor',
      session: null,
      weekly: null,
      monthly: {
        usedPercent: 60,
        windowMinutes: 43_200,
        resetsAt: null,
        resetDescription: 'Aug 1'
      },
      buckets: [
        {
          name: 'Auto',
          usedPercent: 45,
          windowMinutes: 43_200,
          resetsAt: null,
          resetDescription: null
        },
        {
          name: 'API',
          usedPercent: 30,
          windowMinutes: 43_200,
          resetsAt: null,
          resetDescription: null
        }
      ],
      updatedAt: 1,
      error: null,
      status: 'ok'
    },
    minimaxCookieConfigured: false,
    grokAuthConfigured: false,
    cursorAuthConfigured: true,
    claudeTarget: { runtime: 'host', wslDistro: null },
    codexTarget: { runtime: 'host', wslDistro: null },
    inactiveClaudeAccounts: [],
    inactiveCodexAccounts: []
  },
  refreshCursorRateLimits: storeMocks.refreshCursorRateLimits,
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

import { CursorUsagePane } from './CursorUsagePane'

describe('CursorUsagePane', () => {
  beforeEach(() => {
    storeMocks.refreshCursorRateLimits.mockResolvedValue(undefined)
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('does not refresh all providers just from opening the Cursor tab', () => {
    render(<CursorUsagePane />)

    expect(screen.getByTestId('cursor-usage-pane')).toBeInTheDocument()
    expect(screen.getByText('Auto')).toBeInTheDocument()
    expect(screen.getByText('45%')).toBeInTheDocument()
    expect(screen.getByText('API')).toBeInTheDocument()
    expect(screen.getByText('30%')).toBeInTheDocument()
    expect(storeMocks.refreshCursorRateLimits).not.toHaveBeenCalled()
  })

  it('refreshes usage only from the explicit refresh button', async () => {
    const user = userEvent.setup()
    render(<CursorUsagePane />)

    await user.click(screen.getByRole('button', { name: 'Refresh Cursor usage' }))

    expect(storeMocks.refreshCursorRateLimits).toHaveBeenCalledTimes(1)
  })
})
