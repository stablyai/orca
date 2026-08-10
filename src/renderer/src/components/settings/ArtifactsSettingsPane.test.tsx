// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  fetchAuthStatus: vi.fn(),
  openArtifactsPage: vi.fn(),
  state: {
    orcaProfileAuthStatus: {
      configured: true,
      state: 'connected'
    } as Record<string, unknown> | null,
    orcaProfileConnecting: false,
    isWebClient: false
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
      openArtifactsPage: mocks.openArtifactsPage
    })
}))

import { ArtifactsSettingsPane } from './ArtifactsSettingsPane'

describe('ArtifactsSettingsPane', () => {
  beforeEach(() => {
    mocks.connect.mockReset()
    mocks.fetchAuthStatus.mockReset()
    mocks.openArtifactsPage.mockReset()
    mocks.state.orcaProfileAuthStatus = { configured: true, state: 'connected' }
    mocks.state.orcaProfileConnecting = false
    mocks.state.isWebClient = false
  })

  afterEach(cleanup)

  it('explains the complete sharing workflow', () => {
    render(
      <ArtifactsSettingsPane
        settings={{ ...getDefaultSettings('/tmp'), showArtifactsButton: true }}
        updateSettings={vi.fn()}
      />
    )

    expect(screen.getByText('How to use Artifacts')).toBeInTheDocument()
    expect(screen.getByText('Choose a file to share')).toBeInTheDocument()
    expect(
      screen.getByText(
        'Open an HTML or Markdown file and select Share as artifact, or ask an agent to share it.'
      )
    ).toBeInTheDocument()
    expect(screen.getByText('Copy the public link')).toBeInTheDocument()
    expect(
      screen.getByText('After publishing, copy the link and send it to your team.')
    ).toBeInTheDocument()
    expect(screen.getByText('Manage it in Orca')).toBeInTheDocument()
    expect(
      screen.getByText('Preview, copy, and manage links shared through your account.')
    ).toBeInTheDocument()
    expect(
      screen.queryByText('Uploads require sign-in; public links do not.')
    ).not.toBeInTheDocument()
    expect(screen.queryByText('Orca account')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Sign in to Orca' })).not.toBeInTheDocument()
  })

  it('offers sign in for a local profile', async () => {
    const user = userEvent.setup()
    mocks.state.orcaProfileAuthStatus = { configured: true, state: 'local' }
    render(<ArtifactsSettingsPane settings={getDefaultSettings('/tmp')} updateSettings={vi.fn()} />)

    expect(screen.getByText('Sign in to share artifacts')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Sign in to Orca' }))
    expect(mocks.connect).toHaveBeenCalledOnce()
  })

  it('shows reconnect and connecting states', () => {
    mocks.state.orcaProfileAuthStatus = { configured: true, state: 'reconnect-required' }
    const { rerender } = render(
      <ArtifactsSettingsPane settings={getDefaultSettings('/tmp')} updateSettings={vi.fn()} />
    )

    expect(screen.getByRole('button', { name: 'Sign in again' })).toBeEnabled()

    mocks.state.orcaProfileConnecting = true
    rerender(
      <ArtifactsSettingsPane settings={getDefaultSettings('/tmp')} updateSettings={vi.fn()} />
    )
    expect(screen.getByRole('button', { name: 'Signing in…' })).toBeDisabled()
  })

  it('loads missing account status and disables sign in until configured', () => {
    mocks.state.orcaProfileAuthStatus = null
    render(<ArtifactsSettingsPane settings={getDefaultSettings('/tmp')} updateSettings={vi.fn()} />)

    expect(mocks.fetchAuthStatus).toHaveBeenCalledOnce()
    expect(screen.getByRole('button', { name: 'Sign in to Orca' })).toBeDisabled()
  })

  it('controls only sidebar visibility and always allows opening Artifacts', async () => {
    const user = userEvent.setup()
    const updateSettings = vi.fn()
    render(
      <ArtifactsSettingsPane
        settings={{ ...getDefaultSettings('/tmp'), showArtifactsButton: false }}
        updateSettings={updateSettings}
      />
    )

    const toggle = screen.getByRole('switch', { name: 'Show Artifacts Button' })
    expect(toggle).toHaveAttribute('aria-checked', 'false')
    await user.click(toggle)
    expect(updateSettings).toHaveBeenCalledWith({ showArtifactsButton: true })

    expect(screen.queryByText(/orca artifacts share/)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Copy command' })).not.toBeInTheDocument()

    const openButton = screen.getByRole('button', { name: /Open Artifacts/ })
    expect(openButton).toBeEnabled()
    await user.click(openButton)
    expect(mocks.openArtifactsPage).toHaveBeenCalledOnce()
  })

  it('describes public publishing and existing-link retention', () => {
    render(<ArtifactsSettingsPane settings={getDefaultSettings('/tmp')} updateSettings={vi.fn()} />)

    expect(
      screen.getByRole('switch', { name: 'Allow publishing public artifact links' })
    ).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByText(/Publish HTML and Markdown files as links/)).toBeInTheDocument()
    expect(screen.getByText(/Existing links remain until you delete them/)).toBeInTheDocument()
    expect(screen.queryByText(/Off by default/)).not.toBeInTheDocument()
  })

  it('grants and revokes the publish capability through the toggle', async () => {
    const user = userEvent.setup()
    const updateSettings = vi.fn()
    const { rerender } = render(
      <ArtifactsSettingsPane
        settings={{ ...getDefaultSettings('/tmp'), artifactSharingEnabled: false }}
        updateSettings={updateSettings}
      />
    )

    await user.click(screen.getByRole('switch', { name: 'Allow publishing public artifact links' }))
    expect(updateSettings).toHaveBeenCalledWith({ artifactSharingEnabled: true })

    rerender(
      <ArtifactsSettingsPane
        settings={{ ...getDefaultSettings('/tmp'), artifactSharingEnabled: true }}
        updateSettings={updateSettings}
      />
    )
    const toggle = screen.getByRole('switch', { name: 'Allow publishing public artifact links' })
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    await user.click(toggle)
    expect(updateSettings).toHaveBeenLastCalledWith({ artifactSharingEnabled: false })
  })

  it('makes the capability read-only on web, where the grant never reaches the host', async () => {
    const user = userEvent.setup()
    const updateSettings = vi.fn()
    mocks.state.isWebClient = true
    render(
      <ArtifactsSettingsPane
        settings={{ ...getDefaultSettings('/tmp'), artifactSharingEnabled: true }}
        updateSettings={updateSettings}
      />
    )

    const toggle = screen.getByRole('switch', { name: 'Allow publishing public artifact links' })
    // Mirrors the host value so web never claims a capability the host is not enforcing.
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    expect(toggle).toBeDisabled()
    await user.click(toggle)
    expect(updateSettings).not.toHaveBeenCalled()
    expect(screen.getByText(/Desktop only/)).toBeInTheDocument()
  })

  it('leads with the opt-in step while publishing is off, and drops it once granted', () => {
    const { rerender } = render(
      <ArtifactsSettingsPane settings={getDefaultSettings('/tmp')} updateSettings={vi.fn()} />
    )

    expect(screen.getByText('Enable artifact sharing')).toBeInTheDocument()
    expect(
      screen.getByText('Turn on “Allow publishing public artifact links” above.')
    ).toBeInTheDocument()
    expect(screen.getByText(/Enable artifact sharing above/)).toBeInTheDocument()

    rerender(
      <ArtifactsSettingsPane
        settings={{ ...getDefaultSettings('/tmp'), artifactSharingEnabled: true }}
        updateSettings={vi.fn()}
      />
    )
    expect(screen.queryByText('Enable artifact sharing')).not.toBeInTheDocument()
    expect(screen.getByText('Choose a file to share')).toBeInTheDocument()
  })

  it('points web clients at the desktop app for the opt-in step', () => {
    mocks.state.isWebClient = true
    render(<ArtifactsSettingsPane settings={getDefaultSettings('/tmp')} updateSettings={vi.fn()} />)

    expect(
      screen.getByText(/Open Settings → Artifacts in the Orca desktop app on the host device/)
    ).toBeInTheDocument()
  })
})
