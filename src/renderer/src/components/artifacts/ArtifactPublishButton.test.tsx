// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { createRef, type ReactNode } from 'react'
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

  it('supports a controlled virtual anchor without rendering a second trigger', async () => {
    const anchorRef = createRef<HTMLButtonElement>()
    render(
      <>
        <button ref={anchorRef}>Overflow</button>
        <ArtifactPublishButton
          sourceKey="/repo/report.md"
          createRequest={vi.fn()}
          anchorRef={anchorRef}
          open
          onOpenChange={vi.fn()}
        />
      </>
    )

    expect(screen.queryByRole('button', { name: 'Share as artifact' })).toBeNull()
    expect(await screen.findByRole('button', { name: 'Generate link' })).toBeInTheDocument()

    const focus = vi.spyOn(anchorRef.current!, 'focus')
    const closeEvent = new Event('close', { cancelable: true })
    mocks.closePopover?.(closeEvent)
    expect(closeEvent.defaultPrevented).toBe(true)
    expect(focus).toHaveBeenCalledWith({ preventScroll: true })
  })

  it('offers sign-in and blocks confirmation while signed out', async () => {
    const user = userEvent.setup()
    mocks.state.orcaProfileAuthStatus = { configured: true, state: 'local' }
    render(<ArtifactPublishButton sourceKey="/repo/report.md" createRequest={vi.fn()} />)

    expect(await screen.findByRole('button', { name: 'Generate link' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Sign in' }))

    expect(mocks.connect).toHaveBeenCalledOnce()
    expect(mocks.publish).not.toHaveBeenCalled()
  })

  it('routes disabled publishing to Artifacts settings', async () => {
    const user = userEvent.setup()
    mocks.state.settings = { artifactSharingEnabled: false }
    render(<ArtifactPublishButton sourceKey="/repo/report.md" createRequest={vi.fn()} />)

    await user.click(screen.getByRole('button', { name: 'Share as artifact' }))
    expect(await screen.findByRole('button', { name: 'Generate link' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Open Artifacts settings' }))

    expect(mocks.openSettingsTarget).toHaveBeenCalledWith({ pane: 'artifacts', repoId: null })
    expect(mocks.openSettingsPage).toHaveBeenCalledOnce()
    expect(mocks.publish).not.toHaveBeenCalled()
  })

  it('hides the settings prompt once publishing is enabled', () => {
    render(<ArtifactPublishButton sourceKey="/repo/report.md" createRequest={vi.fn()} />)

    expect(screen.queryByText('Artifact sharing is off')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Open Artifacts settings' })).toBeNull()
  })

  it('shows and manages an existing public link', async () => {
    const user = userEvent.setup()
    const createRequest = vi.fn()
    mocks.getPublishedLink.mockResolvedValue('https://share.onorca.dev/a/artifact-a')
    mocks.publish.mockResolvedValue({
      change: 'updated',
      item: { shareUrl: 'https://share.onorca.dev/a/artifact-a' }
    })

    render(<ArtifactPublishButton sourceKey="/repo/report.md" createRequest={createRequest} />)

    await user.click(screen.getByRole('button', { name: 'Share as artifact' }))
    expect(await screen.findByText('https://share.onorca.dev/a/artifact-a')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Copy link' }))
    expect(mocks.copyLink).toHaveBeenCalledWith('https://share.onorca.dev/a/artifact-a', {
      showSuccessToast: false
    })

    await user.click(screen.getByRole('button', { name: 'Update shared content' }))
    await waitFor(() => expect(mocks.publish).toHaveBeenCalledWith(createRequest))
  })

  it('keeps existing links available when publishing is disabled', async () => {
    const user = userEvent.setup()
    mocks.state.settings = { artifactSharingEnabled: false }
    mocks.getPublishedLink.mockResolvedValue('https://share.onorca.dev/a/artifact-a')

    render(<ArtifactPublishButton sourceKey="/repo/report.md" createRequest={vi.fn()} />)

    await user.click(screen.getByRole('button', { name: 'Share as artifact' }))
    expect(await screen.findByRole('button', { name: 'Copy link' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Update shared content' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Open Artifacts settings' })).toBeInTheDocument()
  })

  it('looks up a persisted link only after the popover opens', async () => {
    const user = userEvent.setup()
    render(<ArtifactPublishButton sourceKey="/repo/report.md" createRequest={vi.fn()} />)

    expect(mocks.getPublishedLink).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Share as artifact' }))

    await waitFor(() => expect(mocks.getPublishedLink).toHaveBeenCalledOnce())
  })

  it('does not start copy feedback after the panel unmounts', async () => {
    const user = userEvent.setup()
    let finishCopy: ((copied: boolean) => void) | undefined
    mocks.getPublishedLink.mockResolvedValue('https://share.onorca.dev/a/artifact-a')
    mocks.copyLink.mockReturnValue(
      new Promise<boolean>((resolve) => {
        finishCopy = resolve
      })
    )
    const timeoutSpy = vi.spyOn(window, 'setTimeout')
    const view = render(
      <ArtifactPublishButton sourceKey="/repo/report.md" createRequest={vi.fn()} />
    )
    await user.click(screen.getByRole('button', { name: 'Share as artifact' }))
    await user.click(await screen.findByRole('button', { name: 'Copy link' }))

    view.unmount()
    finishCopy?.(true)
    await Promise.resolve()

    expect(timeoutSpy).not.toHaveBeenCalledWith(expect.any(Function), 1_500)
  })
})
