// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import React from 'react'
import { cleanup, render, screen, fireEvent } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AccountsPaneSectionModel } from './accounts-pane-types'
import { getDefaultSettings } from '../../../../shared/constants'
import {
  emptyClaudeAccountsState,
  emptyCodexAccountsState
} from '@/runtime/runtime-provider-accounts-client'

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

function createModel(overrides: Partial<AccountsPaneSectionModel> = {}): AccountsPaneSectionModel {
  return {
    settings: {
      ...getDefaultSettings('/tmp'),
      antigravityCliOAuthEnabled: true
    },
    updateSettings: vi.fn(),
    searchQuery: '',
    recordFeatureInteraction: vi.fn(),
    wslSupportedPlatform: false,
    wslAvailable: false,
    wslDistros: [],
    wslCapabilitiesLoading: false,
    localAccountRuntime: { runtime: 'host', label: 'Local' },
    localAccountRuntimeSentenceLabel: 'this computer',
    isRemoteAccountScope: false,
    remoteServerName: null,
    remoteAccountScopeNotice: null,
    accountRuntime: { runtime: 'host', label: 'Local' },
    accountRuntimeSentenceLabel: 'this computer',
    accountRuntimeUnavailable: false,
    accountVisibilityOptions: { remoteOwner: false, ownerPlatform: null },
    claudeAccounts: emptyClaudeAccountsState(),
    claudeAction: 'idle',
    visibleClaudeAccounts: [],
    systemClaudeActive: true,
    setRemoveClaudeTarget: vi.fn(),
    runClaudeAccountAction: vi.fn(),
    codexAccounts: emptyCodexAccountsState(),
    codexAction: 'idle',
    visibleCodexAccounts: [],
    systemCodexActive: true,
    systemCodexNeedsSignIn: false,
    systemCodexMissingSignIn: false,
    systemCodexIdentity: undefined,
    activeCodexAuthWarning: null,
    activeCodexAccountId: null,
    codexConfigSync: null,
    codexConfigSyncWarning: null,
    codexRateLimits: null,
    codexRateLimitTarget: { runtime: 'host', wslDistro: null },
    setRemoveCodexTarget: vi.fn(),
    runCodexAccountAction: vi.fn(),
    recordOpenCodeSettingEdit: vi.fn(),
    miniMaxRateLimits: null,
    miniMaxApiKeyDraft: '',
    setMiniMaxApiKeyDraft: vi.fn(),
    miniMaxApiKeyConfigured: false,
    saveMiniMaxApiKey: vi.fn(),
    clearMiniMaxApiKey: vi.fn(),
    miniMaxCookieDraft: '',
    setMiniMaxCookieDraft: vi.fn(),
    miniMaxConfigured: false,
    miniMaxCredentialBusy: false,
    saveMiniMaxCookie: vi.fn(),
    clearMiniMaxCookie: vi.fn(),
    ...overrides
  }
}

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

  it('renders signed in status with user email', async () => {
    const model = createModel()
    render(<AntigravityAccountsSection model={model} />)

    expect(await screen.findByText('dev@example.com')).toBeInTheDocument()
    expect(
      screen.getByText('Signed in. Orca reads the Antigravity CLI credentials stored on disk.')
    ).toBeInTheDocument()
  })

  it('renders model quota buckets when available', async () => {
    mocks.antigravityUsage.mockReturnValue({
      provider: 'antigravity',
      session: null,
      weekly: null,
      buckets: [
        {
          name: 'Gemini 2.5 Pro',
          usedPercent: 45,
          windowMinutes: 300,
          resetsAt: null,
          resetDescription: 'in 2 hours'
        },
        {
          name: 'Gemini 2.5 Flash',
          usedPercent: 12,
          windowMinutes: 300,
          resetsAt: null,
          resetDescription: 'in 4 hours'
        }
      ],
      updatedAt: Date.now(),
      error: null,
      status: 'ok'
    })

    const model = createModel()
    render(<AntigravityAccountsSection model={model} />)

    expect(await screen.findByText('Gemini 2.5 Pro')).toBeInTheDocument()
    expect(screen.getByText('45% used')).toBeInTheDocument()
    expect(screen.getByText('Resets in 2 hours')).toBeInTheDocument()

    expect(screen.getByText('Gemini 2.5 Flash')).toBeInTheDocument()
    expect(screen.getByText('12% used')).toBeInTheDocument()
    expect(screen.getByText('Resets in 4 hours')).toBeInTheDocument()
  })

  it('renders live reset countdown when buckets have resetsAt timestamps', async () => {
    const inTwoHours = Date.now() + 2 * 60 * 60 * 1000 + 5 * 60 * 1000
    mocks.antigravityUsage.mockReturnValue({
      provider: 'antigravity',
      session: null,
      weekly: null,
      buckets: [
        {
          name: 'Gemini 2.5 Pro',
          usedPercent: 45,
          windowMinutes: 60,
          resetsAt: inTwoHours,
          resetDescription: null
        }
      ],
      updatedAt: Date.now(),
      error: null,
      status: 'ok'
    })

    const model = createModel()
    render(<AntigravityAccountsSection model={model} />)

    expect(await screen.findByText('Gemini 2.5 Pro')).toBeInTheDocument()
    // Why: a few ms elapse between computing resetsAt and render, which can
    // floor the countdown down a minute — match either adjacent minute.
    expect(screen.getByText(/Resets in 2h [45]m/)).toBeInTheDocument()
  })

  it('triggers refreshRateLimits when Refresh quota is clicked', async () => {
    const model = createModel()
    render(<AntigravityAccountsSection model={model} />)

    const refreshButton = await screen.findByRole('button', { name: /Refresh quota/i })
    fireEvent.click(refreshButton)

    expect(mocks.refreshRateLimits).toHaveBeenCalled()
    expect(model.recordFeatureInteraction).toHaveBeenCalledWith('usage-tracking')
  })

  it('toggles antigravityCliOAuthEnabled when switch is flipped', async () => {
    const model = createModel()
    render(<AntigravityAccountsSection model={model} />)

    const toggle = await screen.findByRole('switch', {
      name: /Enable Antigravity CLI quota tracking/i
    })
    fireEvent.click(toggle)

    expect(model.updateSettings).toHaveBeenCalledWith({
      antigravityCliOAuthEnabled: false
    })
  })
})
