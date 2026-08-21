// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TooltipProvider } from '@/components/ui/tooltip'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  fetchAuthStatus: vi.fn(),
  openSkillsPage: vi.fn(),
  updateSettings: vi.fn(),
  state: {
    orcaProfileAuthStatus: { configured: true, state: 'connected' } as Record<
      string,
      unknown
    > | null,
    orcaProfileConnecting: false,
    isWebClient: false,
    settings: { showSkillsButton: false, agentSkillSharingEnabled: false }
  }
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

vi.mock('@/lib/web-client-location', () => ({
  isWebClientLocation: () => mocks.state.isWebClient
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      ...mocks.state,
      connectCurrentOrcaProfile: mocks.connect,
      fetchOrcaProfileAuthStatus: mocks.fetchAuthStatus,
      openSkillsPage: mocks.openSkillsPage,
      updateSettings: mocks.updateSettings
    })
}))

import { ShareSkillsSettingsPane } from './ShareSkillsSettingsPane'

describe('ShareSkillsSettingsPane', () => {
  beforeEach(() => {
    mocks.connect.mockReset()
    mocks.fetchAuthStatus.mockReset()
    mocks.openSkillsPage.mockReset()
    mocks.updateSettings.mockReset()
    mocks.state.orcaProfileAuthStatus = { configured: true, state: 'connected' }
    mocks.state.orcaProfileConnecting = false
    mocks.state.isWebClient = false
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        skills: {
          listOwnedShares: vi.fn().mockResolvedValue({ status: 'ok', value: [] }),
          revokeShare: vi.fn()
        }
      }
    })
  })

  afterEach(() => {
    cleanup()
    Reflect.deleteProperty(window, 'api')
  })

  it('explains unlisted multi-skill links and opens Skills', async () => {
    const user = userEvent.setup()
    render(
      <TooltipProvider>
        <ShareSkillsSettingsPane />
      </TooltipProvider>
    )

    expect(screen.getByText('Unlisted skill links')).toBeInTheDocument()
    expect(screen.getByText('Select one or more skills')).toBeInTheDocument()
    expect(
      screen.getByText(
        'Anyone with the link can inspect and install all or selected skills without signing in.'
      )
    ).toBeInTheDocument()
    expect(screen.getByText(/installed on another machine remain there/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Open Skills/ }))
    expect(mocks.openSkillsPage).toHaveBeenCalledOnce()
  })

  it('offers owner sign-in while explaining recipients stay signed out', async () => {
    const user = userEvent.setup()
    mocks.state.orcaProfileAuthStatus = { configured: true, state: 'local' }
    render(
      <TooltipProvider>
        <ShareSkillsSettingsPane />
      </TooltipProvider>
    )

    expect(screen.getByText('Sign in to share skills')).toBeInTheDocument()
    expect(screen.getByText(/Recipients do not need an account/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Sign in to Orca' }))
    expect(mocks.connect).toHaveBeenCalledOnce()
  })

  it('requires an explicit desktop grant for agent publishing', async () => {
    const user = userEvent.setup()
    render(
      <TooltipProvider>
        <ShareSkillsSettingsPane />
      </TooltipProvider>
    )

    await user.click(
      screen.getByRole('switch', {
        name: 'Allow agents and the Orca CLI to publish skill links'
      })
    )
    expect(mocks.updateSettings).toHaveBeenCalledWith({ agentSkillSharingEnabled: true })
  })

  it('does not offer desktop publishing from the web client', () => {
    mocks.state.isWebClient = true
    mocks.state.orcaProfileAuthStatus = { configured: true, state: 'local' }
    render(
      <TooltipProvider>
        <ShareSkillsSettingsPane />
      </TooltipProvider>
    )

    expect(screen.getByText(/available in the Orca desktop app/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Open Skills/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Sign in to Orca' })).not.toBeInTheDocument()
    expect(
      screen.getByRole('switch', {
        name: 'Allow agents and the Orca CLI to publish skill links'
      })
    ).toBeDisabled()
  })
})
