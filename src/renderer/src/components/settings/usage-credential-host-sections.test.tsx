// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as UsageCredentialsClient from '@/runtime/runtime-usage-credentials-client'

const mocks = vi.hoisted(() => ({
  callMiniMax: vi.fn(),
  callZcode: vi.fn(),
  update: vi.fn(),
  toastError: vi.fn(),
  settingsSearchQuery: ''
}))

vi.mock('@/runtime/runtime-usage-credentials-client', async (importOriginal) => ({
  ...(await importOriginal<typeof UsageCredentialsClient>()),
  callMiniMaxCredentials: mocks.callMiniMax,
  callZcodePlanCredentials: mocks.callZcode
}))
vi.mock('@/lib/agent-catalog', () => ({ AgentIcon: () => React.createElement('span') }))
vi.mock('../status-bar/icons', () => ({ MiniMaxIcon: () => React.createElement('span') }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: mocks.toastError } }))
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
      recordFeatureInteraction: vi.fn(),
      refreshRateLimits: vi.fn(),
      settingsSearchQuery: mocks.settingsSearchQuery,
      rateLimits: { zcode: null }
    })
}))

import { UsageCredentialsHostOutdatedError } from '@/runtime/runtime-usage-credentials-client'
import { MiniMaxAccountsSection } from './MiniMaxAccountsSection'
import { ZcodePlanAccountsSection } from './ZcodePlanAccountsSection'

const owner = { kind: 'environment' as const, environmentId: 'server-a' }
const host = { owner, label: 'Build box' }
const usageSettings = {
  settings: { minimaxEndpoint: 'overseas' as const, zcodePlanSite: 'zai' as const },
  update: mocks.update
}
const miniMaxStatus = {
  configured: true,
  cookieConfigured: false,
  apiKeyConfigured: true,
  cookieProtection: null,
  apiKeyProtection: 'sealed' as const,
  sessionCookieSupported: false
}

function renderMiniMax(): void {
  render(
    <MiniMaxAccountsSection
      host={host}
      usageSettings={usageSettings}
      miniMaxRateLimits={null}
      recordFeatureInteraction={vi.fn()}
    />
  )
}

beforeEach(() => {
  mocks.callMiniMax.mockReset().mockResolvedValue(miniMaxStatus)
  mocks.callZcode.mockReset().mockResolvedValue({
    apiKeyConfigured: false,
    zcodeCliConfigured: false,
    apiKeyProtection: null
  })
})

afterEach(() => {
  mocks.settingsSearchQuery = ''
  cleanup()
  vi.clearAllMocks()
})

describe('usage keys on the Settings host', () => {
  it('says MiniMax keys are stored on the host and saves there', async () => {
    renderMiniMax()

    expect(await screen.findByText('Stored on Build box')).toBeInTheDocument()
    fireEvent.change(screen.getByPlaceholderText('Paste your MiniMax API key'), {
      target: { value: '  key-a  ' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Replace' }))

    await waitFor(() =>
      expect(mocks.callMiniMax).toHaveBeenCalledWith(owner, 'saveApiKey', 'key-a')
    )
  })

  it('finds the MiniMax API key by its host, not as stored locally', async () => {
    mocks.settingsSearchQuery = 'stored locally'
    renderMiniMax()
    await waitFor(() => expect(mocks.callMiniMax).toHaveBeenCalled())
    expect(screen.queryByPlaceholderText('Paste your MiniMax API key')).not.toBeInTheDocument()
    cleanup()

    mocks.settingsSearchQuery = 'stored on build box'
    renderMiniMax()
    expect(await screen.findByPlaceholderText('Paste your MiniMax API key')).toBeInTheDocument()
  })

  it('disables the cookie where the host has no desktop cookie jar', async () => {
    renderMiniMax()

    expect(
      await screen.findByText(
        'Build box has no Orca desktop app to send a session cookie from. Save an API key instead.'
      )
    ).toBeInTheDocument()
    expect(screen.getByPlaceholderText('Paste the Cookie header from DevTools')).toBeDisabled()
    expect(screen.getByPlaceholderText('Paste your MiniMax API key')).toBeEnabled()
  })

  it('locks replacing a key the other Orca app on the host sealed, but still allows forgetting it', async () => {
    mocks.callMiniMax.mockResolvedValue({ ...miniMaxStatus, apiKeyUnreadable: 'sealed-elsewhere' })
    renderMiniMax()

    expect(
      await screen.findByText(
        'Saved by another Orca app on Build box, which this one cannot read. Change it in that app, or forget it here.'
      )
    ).toBeInTheDocument()
    expect(screen.getByPlaceholderText('Paste your MiniMax API key')).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Forget key' })).toBeEnabled()
  })

  it('keeps an unreadable key replaceable and says so', async () => {
    mocks.callMiniMax.mockResolvedValue({ ...miniMaxStatus, apiKeyUnreadable: 'unreadable' })
    renderMiniMax()

    expect(
      await screen.findByText(
        'Orca on Build box cannot read the saved key. Replace it or forget it.'
      )
    ).toBeInTheDocument()
    expect(screen.getByPlaceholderText('Paste your MiniMax API key')).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Forget key' })).toBeEnabled()
  })

  it('asks to update an older host and offers no save', async () => {
    mocks.callMiniMax.mockRejectedValue(new UsageCredentialsHostOutdatedError())
    renderMiniMax()

    expect(
      await screen.findByText('Update Orca on Build box to save this key there.')
    ).toBeInTheDocument()
    expect(screen.queryByText('Credentials not set')).not.toBeInTheDocument()
    expect(screen.getByPlaceholderText('Paste your MiniMax API key')).toBeDisabled()
    expect(mocks.callMiniMax).toHaveBeenCalledTimes(1)
  })

  it('shows an unreachable host as unknown, not as having no key', async () => {
    mocks.callMiniMax.mockRejectedValue(new Error('timed out'))
    renderMiniMax()

    expect(
      await screen.findByText(
        'Could not reach Build box, so whether a key is saved there is unknown.'
      )
    ).toBeInTheDocument()
    expect(screen.queryByText('Credentials not set')).not.toBeInTheDocument()
    expect(screen.getByPlaceholderText('Paste your MiniMax API key')).toBeDisabled()
  })

  it('asks to update an older host for the GLM key and keeps this computer’s CLI setup out', async () => {
    mocks.callZcode.mockRejectedValue(new UsageCredentialsHostOutdatedError())
    render(<ZcodePlanAccountsSection host={host} usageSettings={usageSettings} />)

    expect(
      await screen.findByText('Update Orca on Build box to save this key there.')
    ).toBeInTheDocument()
    expect(screen.queryByText('No GLM Coding Plan linked')).not.toBeInTheDocument()
    expect(screen.getByPlaceholderText('Paste your GLM Coding Plan API key')).toBeDisabled()
    expect(screen.getByRole('combobox')).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Refresh usage' })).not.toBeInTheDocument()
  })

  it('names the host when no GLM plan is linked there', async () => {
    render(<ZcodePlanAccountsSection host={host} usageSettings={usageSettings} />)

    expect(
      await screen.findByText(
        'Save the plan API key below, or sign in with the ZCode CLI on Build box.'
      )
    ).toBeInTheDocument()
    expect(screen.getByPlaceholderText('Paste your GLM Coding Plan API key')).toBeEnabled()
  })

  it('finds the GLM API key by its host, not as stored locally', async () => {
    mocks.settingsSearchQuery = 'stored locally'
    render(<ZcodePlanAccountsSection host={host} usageSettings={usageSettings} />)
    await waitFor(() => expect(mocks.callZcode).toHaveBeenCalled())
    expect(
      screen.queryByPlaceholderText('Paste your GLM Coding Plan API key')
    ).not.toBeInTheDocument()
    cleanup()

    mocks.settingsSearchQuery = 'stored on build box'
    render(<ZcodePlanAccountsSection host={host} usageSettings={usageSettings} />)
    expect(
      await screen.findByPlaceholderText('Paste your GLM Coding Plan API key')
    ).toBeInTheDocument()
  })
})
