// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import type { ReactNode } from 'react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type ArtifactPublishButtonMocks = {
  connect: ReturnType<typeof vi.fn>
  openSettingsPage: ReturnType<typeof vi.fn>
  openSettingsTarget: ReturnType<typeof vi.fn>
  getPublishedLink: ReturnType<typeof vi.fn>
  copyLink: ReturnType<typeof vi.fn>
  openLink: ReturnType<typeof vi.fn>
  publish: ReturnType<typeof vi.fn>
  openPopover: ((open: boolean) => void) | null
  closePopover: ((event: Event) => void) | null
  state: {
    orcaProfileAuthStatus: Record<string, unknown>
    settings: { artifactSharingEnabled: boolean }
  }
}

const mocks = vi.hoisted<ArtifactPublishButtonMocks>(() => ({
  connect: vi.fn(),
  openSettingsPage: vi.fn(),
  openSettingsTarget: vi.fn(),
  getPublishedLink: vi.fn(),
  copyLink: vi.fn(),
  openLink: vi.fn(),
  publish: vi.fn(),
  openPopover: null,
  closePopover: null,
  state: {
    orcaProfileAuthStatus: { configured: true, state: 'connected' },
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
  Popover: ({
    children,
    onOpenChange
  }: {
    children: ReactNode
    onOpenChange?: (open: boolean) => void
  }) => {
    mocks.openPopover = onOpenChange ?? null
    return <>{children}</>
  },
  PopoverAnchor: ({ children }: { children?: ReactNode }) => <>{children}</>,
  PopoverContent: ({
    children,
    onCloseAutoFocus
  }: {
    children: ReactNode
    onCloseAutoFocus?: (event: Event) => void
  }) => {
    mocks.closePopover = onCloseAutoFocus ?? null
    return <div>{children}</div>
  },
  PopoverTrigger: ({ children }: { children: ReactNode }) => (
    <span onClick={() => mocks.openPopover?.(true)}>{children}</span>
  )
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
vi.mock('./artifact-published-link-client', () => ({
  getPublishedArtifactLink: mocks.getPublishedLink
}))
vi.mock('./artifact-link-actions', () => ({
  copyArtifactLink: mocks.copyLink,
  openArtifactInBrowser: mocks.openLink
}))

import { ArtifactPublishButton } from './ArtifactPublishButton'

describe('ArtifactPublishButton', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.publish.mockResolvedValue({
      change: 'created',
      item: { shareUrl: 'https://example.com' }
    })
    mocks.getPublishedLink.mockResolvedValue(null)
    mocks.copyLink.mockResolvedValue(true)
    mocks.openPopover = null
    mocks.closePopover = null
    mocks.state.orcaProfileAuthStatus = { configured: true, state: 'connected' }
    mocks.state.settings = { artifactSharingEnabled: true }
  })

  afterEach(cleanup)

  it('requires explicit confirmation before publishing', async () => {
    const user = userEvent.setup()
    const createRequest = vi.fn()
    render(<ArtifactPublishButton sourceKey="/repo/report.md" createRequest={createRequest} />)

    await user.click(screen.getByRole('button', { name: 'Share as artifact' }))
    expect(mocks.publish).not.toHaveBeenCalled()

    await user.click(await screen.findByRole('button', { name: 'Generate link' }))
    await waitFor(() => expect(mocks.publish).toHaveBeenCalledWith(createRequest))
    expect(screen.getByText('https://example.com')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Update shared content' })).toBeInTheDocument()
  })
})
