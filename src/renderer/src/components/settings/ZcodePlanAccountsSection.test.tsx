// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import React from 'react'
import type { ZcodePlanSite } from '../../../../shared/zcode-plan-sites'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const settings: { zcodePlanSite?: ZcodePlanSite } = { zcodePlanSite: 'zai' }
  return {
    isWeb: vi.fn(() => false),
    getStatus: vi.fn(),
    saveApiKey: vi.fn(),
    clearApiKey: vi.fn(),
    refreshRateLimits: vi.fn(),
    updateSettings: vi.fn(),
    recordFeatureInteraction: vi.fn(),
    zcodeUsage: vi.fn<() => unknown>(() => null),
    settings
  }
})

vi.mock('@/lib/web-client-location', () => ({ isWebClientLocation: mocks.isWeb }))

vi.mock('@/lib/agent-catalog', () => ({
  AgentIcon: () => React.createElement('span', { 'data-testid': 'zcode-icon' })
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
      updateSettings: mocks.updateSettings,
      recordFeatureInteraction: mocks.recordFeatureInteraction,
      settingsSearchQuery: '',
      settings: mocks.settings,
      rateLimits: { zcode: mocks.zcodeUsage() }
    })
}))

import { ZcodePlanAccountsSection } from './ZcodePlanAccountsSection'

describe('ZcodePlanAccountsSection', () => {
  beforeEach(() => {
    mocks.isWeb.mockReturnValue(false)
    mocks.getStatus.mockResolvedValue({ apiKeyConfigured: false, zcodeCliConfigured: false })
    mocks.saveApiKey.mockResolvedValue({ apiKeyConfigured: true, zcodeCliConfigured: false })
    mocks.clearApiKey.mockResolvedValue({ apiKeyConfigured: false, zcodeCliConfigured: false })
    mocks.refreshRateLimits.mockResolvedValue(undefined)
    mocks.updateSettings.mockResolvedValue(undefined)
    mocks.recordFeatureInteraction.mockReset()
    mocks.zcodeUsage.mockReturnValue(null)
    mocks.settings.zcodePlanSite = 'zai'
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        zcodePlanCredentials: {
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

  it('disables site and secret editing on a paired web client', async () => {
    mocks.isWeb.mockReturnValue(true)
    mocks.settings.zcodePlanSite = 'bigmodel'
    render(<ZcodePlanAccountsSection />)
    expect(
      await screen.findByText(
        'Change the plan site and API key in the desktop app on the computer running Orca.'
      )
    ).toBeInTheDocument()
    expect(screen.getByRole('combobox')).toBeDisabled()
    expect(screen.getByRole('combobox')).toHaveTextContent('Zhipu · BigModel')
    expect(screen.getByPlaceholderText('Paste your GLM Coding Plan API key')).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  })

  it('keeps paired host credentials unknown beside successful quota', async () => {
    mocks.isWeb.mockReturnValue(true)
    mocks.zcodeUsage.mockReturnValue({
      provider: 'zcode',
      status: 'ok',
      error: null,
      planType: null,
      session: { usedPercent: 42, windowMinutes: 300, resetsAt: null, resetDescription: null },
      weekly: null,
      monthly: null,
      updatedAt: 1
    })
    render(<ZcodePlanAccountsSection />)
    expect(await screen.findByText('42%')).toBeInTheDocument()
    expect(
      screen.getByText('Plan credential details are only readable on the computer running Orca.')
    ).toBeInTheDocument()
    expect(screen.queryByText('No GLM Coding Plan linked')).not.toBeInTheDocument()
    expect(screen.queryByText('Not saved')).not.toBeInTheDocument()
  })

  it('does not invent a site or console link for an older host', async () => {
    mocks.isWeb.mockReturnValue(true)
    delete mocks.settings.zcodePlanSite
    render(<ZcodePlanAccountsSection />)
    expect(await screen.findByText('Host plan site unavailable')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Get API key' })).not.toBeInTheDocument()
    expect(screen.getByRole('combobox')).toBeDisabled()
  })

  it('shows the unlinked state when neither an API key nor a CLI config exists', async () => {
    render(<ZcodePlanAccountsSection />)

    expect(await screen.findByText('No GLM Coding Plan linked')).toBeInTheDocument()
    expect(screen.queryByText('Using the ZCode CLI sign-in')).not.toBeInTheDocument()
  })

  it('explains the CLI fallback when only the ZCode CLI config exists', async () => {
    mocks.getStatus.mockResolvedValue({ apiKeyConfigured: false, zcodeCliConfigured: true })

    render(<ZcodePlanAccountsSection />)

    expect(await screen.findByText('Using the ZCode CLI sign-in')).toBeInTheDocument()
    expect(screen.getByText(/~\/\.zcode\/cli\/config\.json/)).toBeInTheDocument()
  })

  it('saves a trimmed API key through the credential IPC', async () => {
    render(<ZcodePlanAccountsSection />)

    const input = await screen.findByPlaceholderText('Paste your GLM Coding Plan API key')
    fireEvent.change(input, { target: { value: '  glm-secret  ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(mocks.saveApiKey).toHaveBeenCalledWith('glm-secret')
    })
    expect(mocks.recordFeatureInteraction).toHaveBeenCalledWith('usage-tracking')
    await screen.findByText('Replace')
  })

  it('requires a non-empty key before saving', async () => {
    render(<ZcodePlanAccountsSection />)

    const save = await screen.findByRole('button', { name: 'Save' })
    expect(save).toBeDisabled()
  })

  it('forgets a saved key through the credential IPC', async () => {
    mocks.getStatus.mockResolvedValue({ apiKeyConfigured: true, zcodeCliConfigured: true })

    render(<ZcodePlanAccountsSection />)

    fireEvent.click(await screen.findByRole('button', { name: 'Forget key' }))

    await waitFor(() => {
      expect(mocks.clearApiKey).toHaveBeenCalledTimes(1)
    })
    expect(mocks.recordFeatureInteraction).toHaveBeenCalledWith('usage-tracking')
  })

  it('labels the saved state with the selected site', async () => {
    mocks.getStatus.mockResolvedValue({ apiKeyConfigured: true, zcodeCliConfigured: false })
    mocks.settings.zcodePlanSite = 'bigmodel'

    render(<ZcodePlanAccountsSection />)

    expect(
      await screen.findByText('API key saved · Zhipu · BigModel (open.bigmodel.cn)')
    ).toBeInTheDocument()
  })

  it('renders the live quota windows for a linked plan', async () => {
    mocks.getStatus.mockResolvedValue({ apiKeyConfigured: true, zcodeCliConfigured: false })
    mocks.zcodeUsage.mockReturnValue({
      provider: 'zcode',
      status: 'ok',
      error: null,
      planType: 'max',
      session: { usedPercent: 42, windowMinutes: 300, resetsAt: null, resetDescription: null },
      weekly: { usedPercent: 73, windowMinutes: 10080, resetsAt: null, resetDescription: null },
      monthly: null,
      updatedAt: Date.now()
    })

    render(<ZcodePlanAccountsSection />)

    expect(await screen.findByText('42%')).toBeInTheDocument()
    expect(screen.getByText('73%')).toBeInTheDocument()
    expect(screen.getByText('Plan: max')).toBeInTheDocument()
  })

  it('renders the reset countdown once, not doubled', async () => {
    mocks.getStatus.mockResolvedValue({ apiKeyConfigured: true, zcodeCliConfigured: false })
    mocks.zcodeUsage.mockReturnValue({
      provider: 'zcode',
      status: 'ok',
      error: null,
      planType: null,
      // Why 47.5 minutes: the floor survives a minute-boundary crossing between
      // mock setup and render, so the assertion stays deterministic.
      session: {
        usedPercent: 42,
        windowMinutes: 300,
        resetsAt: Date.now() + 47 * 60_000 + 30_000,
        resetDescription: null
      },
      weekly: null,
      monthly: null,
      updatedAt: Date.now()
    })

    render(<ZcodePlanAccountsSection />)

    expect(await screen.findByText('42%')).toBeInTheDocument()
    expect(screen.getByText(/5 hours — resets in 47m/)).toBeInTheDocument()
    expect(screen.queryByText(/Resets in Resets/)).not.toBeInTheDocument()
  })
})

describe('GLM credential status races', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('keeps the saved status when an earlier status read finishes late', async () => {
    let finishRead: ((value: unknown) => void) | undefined
    mocks.getStatus.mockResolvedValue({
      apiKeyConfigured: true,
      zcodeCliConfigured: false,
      apiKeyProtection: 'sealed'
    })
    mocks.getStatus.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRead = resolve
        })
    )
    mocks.saveApiKey.mockResolvedValue({
      apiKeyConfigured: true,
      zcodeCliConfigured: false,
      apiKeyProtection: 'sealed'
    })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        zcodePlanCredentials: {
          getStatus: mocks.getStatus,
          saveApiKey: mocks.saveApiKey,
          clearApiKey: mocks.clearApiKey
        }
      }
    })
    render(<ZcodePlanAccountsSection />)
    fireEvent.change(screen.getByPlaceholderText('Paste your GLM Coding Plan API key'), {
      target: { value: 'synthetic-key' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await screen.findByRole('button', { name: 'Forget key' })
    finishRead?.({ apiKeyConfigured: false, zcodeCliConfigured: false, apiKeyProtection: null })
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Forget key' })).toBeInTheDocument()
    )
  })
})
