// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import type { ReactNode } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  openSettingsPage: vi.fn(),
  openSettingsTarget: vi.fn(),
  publish: vi.fn(),
  state: {
    orcaProfileAuthStatus: { configured: true, state: 'connected' } as Record<string, unknown>,
    orcaProfileConnecting: false,
    settings: { artifactSharingEnabled: true }
  }
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      ...mocks.state,
      connectCurrentOrcaProfile: mocks.connect,
      openSettingsPage: mocks.openSettingsPage,
      openSettingsTarget: mocks.openSettingsTarget
    })
}))

vi.mock('@/components/ui/popover', () => ({
  Popover: ({ children }: { children: ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

vi.mock('./artifact-publish-flow', () => ({
  publishArtifactFromSurface: mocks.publish
}))

import { ArtifactPublishButton } from './ArtifactPublishButton'

describe('ArtifactPublishButton', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.publish.mockResolvedValue({
      change: 'created',
      item: { shareUrl: 'https://example.com' }
    })
    mocks.state.orcaProfileAuthStatus = { configured: true, state: 'connected' }
    mocks.state.orcaProfileConnecting = false
    mocks.state.settings = { artifactSharingEnabled: true }
  })

  afterEach(cleanup)

  it('requires explicit confirmation before publishing', async () => {
    const user = userEvent.setup()
    const createRequest = vi.fn()
    render(<ArtifactPublishButton createRequest={createRequest} />)

    await user.click(screen.getByRole('button', { name: 'Share as artifact' }))
    expect(mocks.publish).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Share public link' }))
    expect(mocks.publish).toHaveBeenCalledWith(createRequest)
  })

  it('offers sign-in and blocks confirmation while signed out', async () => {
    const user = userEvent.setup()
    mocks.state.orcaProfileAuthStatus = { configured: true, state: 'local' }
    render(<ArtifactPublishButton createRequest={vi.fn()} />)

    expect(screen.getByRole('button', { name: 'Share public link' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Sign in' }))

    expect(mocks.connect).toHaveBeenCalledOnce()
    expect(mocks.publish).not.toHaveBeenCalled()
  })

  it('routes disabled publishing to Artifacts settings', async () => {
    const user = userEvent.setup()
    mocks.state.settings = { artifactSharingEnabled: false }
    render(<ArtifactPublishButton createRequest={vi.fn()} />)

    expect(screen.getByRole('button', { name: 'Share public link' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Open Artifacts settings' }))

    expect(mocks.openSettingsTarget).toHaveBeenCalledWith({ pane: 'artifacts', repoId: null })
    expect(mocks.openSettingsPage).toHaveBeenCalledOnce()
    expect(mocks.publish).not.toHaveBeenCalled()
  })

  it('hides the settings prompt once publishing is enabled', () => {
    render(<ArtifactPublishButton createRequest={vi.fn()} />)

    expect(screen.queryByText('Artifact sharing is off')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Open Artifacts settings' })).toBeNull()
  })
})
