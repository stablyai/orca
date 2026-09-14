// @vitest-environment happy-dom
import type { ReactNode } from 'react'
import { useRef } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LinkActionPopover } from '@/components/link-actions/LinkActionPopover'
import CommentMarkdown from '@/components/sidebar/CommentMarkdown'
import { useNativeChatLinkActions } from './use-native-chat-link-actions'

const mocks = vi.hoisted(() => ({
  openHttpLink: vi.fn(),
  openFileLink: vi.fn(),
  settings: { openLinksInApp: true, terminalLinkActionPopoverEnabled: true } as {
    openLinksInApp?: boolean
    terminalLinkActionPopoverEnabled?: boolean
  }
}))

vi.mock('@/lib/http-link-routing', () => ({ openHttpLink: mocks.openHttpLink }))

vi.mock('./native-chat-http-link-source-owner', () => ({
  resolveNativeChatHttpLinkSourceOwner: () => ({ kind: 'local' }),
  canNativeChatOpenOwnedBrowser: () => false
}))

vi.mock('./use-native-chat-file-link-click', () => ({
  useNativeChatFileLinkClick: (context: unknown) => (context ? mocks.openFileLink : undefined)
}))

vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) =>
      selector({ openSettingsPage: vi.fn(), openSettingsTarget: vi.fn() }),
    { getState: () => ({ settings: mocks.settings }) }
  )
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ children }: { children: ReactNode }) => children,
  TooltipContent: ({ children }: { children: ReactNode }) => <span>{children}</span>
}))

vi.mock('@/components/ui/popover', () => ({
  Popover: ({ children, open }: { children: ReactNode; open: boolean }) =>
    open ? <div>{children}</div> : null,
  PopoverAnchor: () => null,
  PopoverContent: ({ children }: { children: ReactNode }) => <div>{children}</div>
}))

const context = { worktreeId: 'wt-1', worktreePath: '/repo', runtimeEnvironmentId: null }

function Transcript({
  markdown,
  sessionId = 'session-1',
  isVisible = true,
  linkContext = context
}: {
  markdown: string
  sessionId?: string
  isVisible?: boolean
  linkContext?: typeof context | null
}): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null)
  const { onLinkClick, linkActionRequest, closeLinkActions } = useNativeChatLinkActions(
    linkContext,
    rootRef,
    { sessionId, isVisible }
  )
  return (
    <div ref={rootRef}>
      <CommentMarkdown
        content={markdown}
        variant="document"
        onLinkClick={onLinkClick}
        allowFileUriLinks
      />
      <LinkActionPopover request={linkActionRequest} onClose={closeLinkActions} />
    </div>
  )
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  mocks.settings = { openLinksInApp: true, terminalLinkActionPopoverEnabled: true }
})

describe('native chat transcript links', () => {
  it.each(['hidden', 'session', 'workspace', 'no-context'] as const)(
    'dismisses a request when the transcript is %s',
    async (change) => {
      const markdown = '[link](https://example.com)'
      const { rerender } = render(<Transcript markdown={markdown} />)
      fireEvent.click(await screen.findByRole('link', { name: 'link' }))
      expect(screen.getByText('System Browser')).toBeTruthy()
      rerender(
        <Transcript
          markdown={markdown}
          linkContext={
            change === 'no-context'
              ? null
              : change === 'workspace'
                ? { ...context, worktreeId: 'wt-2' }
                : context
          }
          isVisible={change !== 'hidden'}
          sessionId={change === 'session' ? 'session-2' : 'session-1'}
        />
      )
      expect(screen.queryByText('System Browser')).toBeNull()
      rerender(<Transcript markdown={markdown} />)
      expect(screen.queryByText('System Browser')).toBeNull()
      expect(mocks.openHttpLink).not.toHaveBeenCalled()
    }
  )

  it('offers both destinations when a rendered http link is clicked', async () => {
    render(<Transcript markdown="See [the PR](https://github.com/o/r/pull/1)." />)

    fireEvent.click(await screen.findByRole('link', { name: 'the PR' }))

    expect(screen.getByText('https://github.com/o/r/pull/1')).toBeTruthy()
    expect(screen.getByText('Orca Browser')).toBeTruthy()
    expect(screen.getByText('System Browser')).toBeTruthy()
    expect(mocks.openHttpLink).not.toHaveBeenCalled()
  })

  it('keeps mailto links on the anchor default', async () => {
    const { container } = render(<Transcript markdown="[email](mailto:hello@example.com)" />)
    const anchorDefault = vi.fn((event: Event) => {
      expect(event.defaultPrevented).toBe(false)
      event.preventDefault()
    })
    container.addEventListener('click', anchorDefault)
    fireEvent.click(await screen.findByRole('link', { name: 'email' }))
    expect(anchorDefault).toHaveBeenCalledOnce()
    expect(mocks.openHttpLink).not.toHaveBeenCalled()
    expect(mocks.openFileLink).not.toHaveBeenCalled()
    expect(screen.queryByText('System Browser')).toBeNull()
  })

  it('restores focus to the clicked transcript link', async () => {
    render(<Transcript markdown="[link](https://example.com)" />)
    const anchor = await screen.findByRole('link', { name: 'link' })
    fireEvent.click(anchor)
    fireEvent.click(screen.getByText('System Browser'))
    expect(document.activeElement).toBe(anchor)
  })

  it('routes the chosen destination through the shared link opener', async () => {
    render(<Transcript markdown="See [the PR](https://github.com/o/r/pull/1)." />)
    fireEvent.click(await screen.findByRole('link', { name: 'the PR' }))

    fireEvent.click(screen.getByText('System Browser'))

    expect(mocks.openHttpLink).toHaveBeenCalledWith(
      'https://github.com/o/r/pull/1',
      expect.objectContaining({ forceSystemBrowser: true, worktreeId: 'wt-1' })
    )
  })

  it('opens the routed destination outright when link actions are off', async () => {
    mocks.settings = { openLinksInApp: true, terminalLinkActionPopoverEnabled: false }
    render(<Transcript markdown="See [the PR](https://github.com/o/r/pull/1)." />)

    fireEvent.click(await screen.findByRole('link', { name: 'the PR' }))

    expect(screen.queryByText('Orca Browser')).toBeNull()
    expect(mocks.openHttpLink).toHaveBeenCalledWith(
      'https://github.com/o/r/pull/1',
      expect.objectContaining({ forceInApp: true })
    )
  })

  it('leaves file links on the existing native chat opener', async () => {
    render(<Transcript markdown="Edit [the file](file:///repo/src/a.ts)." />)

    fireEvent.click(await screen.findByRole('link', { name: 'the file' }))

    expect(mocks.openFileLink).toHaveBeenCalledOnce()
    expect(screen.queryByText('System Browser')).toBeNull()
  })
})
