// @vitest-environment happy-dom
import type { ReactNode } from 'react'
import { useRef } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LinkActionPopover } from '@/components/link-actions/LinkActionPopover'
import CommentMarkdown from '@/components/sidebar/CommentMarkdown'
import { useNativeChatLinkActions } from './use-native-chat-link-actions'
import type * as HttpLinkRoutingModule from '@/lib/http-link-routing'

const mocks = vi.hoisted(() => ({
  openHttpLink: vi.fn(),
  openFileLink: vi.fn(),
  settings: { openLinksInApp: true, terminalLinkActionPopoverEnabled: true } as {
    openLinksInApp?: boolean
    terminalLinkActionPopoverEnabled?: boolean
  }
}))

vi.mock('@/lib/http-link-routing', async (importOriginal) => ({
  ...(await importOriginal<typeof HttpLinkRoutingModule>()),
  openHttpLink: mocks.openHttpLink
}))

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
})
