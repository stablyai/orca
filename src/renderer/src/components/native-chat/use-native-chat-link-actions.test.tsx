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

vi.mock('../../store', () => ({
  useAppStore: Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) =>
      selector({ openSettingsPage: vi.fn(), openSettingsTarget: vi.fn() }),
    { getState: () => ({ settings: mocks.settings }) }
  )
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ openSettingsPage: vi.fn(), openSettingsTarget: vi.fn() })
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

function Transcript({ markdown }: { markdown: string }): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null)
  const { onLinkClick, linkActionRequest, closeLinkActions } = useNativeChatLinkActions(
    context,
    rootRef
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
  it('offers both destinations when a rendered http link is clicked', async () => {
    render(<Transcript markdown="See [the PR](https://github.com/o/r/pull/1)." />)

    fireEvent.click(await screen.findByRole('link', { name: 'the PR' }))

    expect(screen.getByText('https://github.com/o/r/pull/1')).toBeTruthy()
    expect(screen.getByText('Orca Browser')).toBeTruthy()
    expect(screen.getByText('System Browser')).toBeTruthy()
    expect(mocks.openHttpLink).not.toHaveBeenCalled()
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
