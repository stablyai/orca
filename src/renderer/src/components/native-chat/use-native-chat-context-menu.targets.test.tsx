// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { useRef } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as HttpLinkDestinations from '@/lib/http-link-destinations'
import type * as TerminalFileOpenRouting from '@/components/terminal-pane/terminal-file-open-routing'
import { createNativeChatFileHref } from '../../../../shared/native-chat/native-chat-href-routing'
import type { NativeChatComposerHandle } from './native-chat-composer-types'
import type { NativeChatRewindSurface } from './use-native-chat-rewind'
import {
  emptyNativeChatContextMenuActions,
  useNativeChatContextMenu,
  type NativeChatContextMenuActions
} from './use-native-chat-context-menu'

const mocks = vi.hoisted(() => ({
  openRoutedHttpLink: vi.fn(),
  openDetectedFilePath: vi.fn(),
  writeClipboardText: vi.fn(),
  confirm: vi.fn(),
  appendText: vi.fn()
}))

vi.mock('@/lib/http-link-destinations', async (importOriginal) => ({
  ...(await importOriginal<typeof HttpLinkDestinations>()),
  openRoutedHttpLink: mocks.openRoutedHttpLink
}))
vi.mock('@/components/terminal-pane/terminal-file-open-routing', async (importOriginal) => ({
  ...(await importOriginal<typeof TerminalFileOpenRouting>()),
  openDetectedFilePath: mocks.openDetectedFilePath
}))
vi.mock('./native-chat-http-link-source-owner', () => ({
  resolveNativeChatHttpLinkSourceOwner: () => ({ kind: 'local' }),
  canNativeChatOpenOwnedBrowser: () => false
}))
vi.mock('@/components/confirmation-dialog-context', () => ({
  useConfirmationDialog: () => mocks.confirm
}))

const linkContext = { worktreeId: 'wt-1', worktreePath: '/repo', runtimeEnvironmentId: null }

function Chat({
  acceptsText = true,
  rewind,
  onFind,
  actions,
  childInheritsLinkContext = false
}: {
  acceptsText?: boolean
  rewind?: NativeChatRewindSurface
  onFind?: () => void
  actions?: Partial<NativeChatContextMenuActions>
  childInheritsLinkContext?: boolean
}): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null)
  const composerRef = useRef<NativeChatComposerHandle | null>({
    focus: () => true,
    insertTypedText: () => true,
    acceptsText: () => acceptsText,
    appendText: mocks.appendText,
    handlePasteEvent: () => {},
    pasteFromClipboard: () => {},
    contains: () => false
  })
  const { menu, onContextMenuCapture } = useNativeChatContextMenu({
    rootRef,
    composerRef,
    actions: { ...emptyNativeChatContextMenuActions, ...actions, onPaste: vi.fn() },
    showTerminalPaneActions: actions !== undefined,
    fileLinkContext: linkContext,
    rewind,
    onFind
  })
  return (
    <div ref={rootRef} onContextMenuCapture={onContextMenuCapture}>
      <p data-native-chat-quote-source="">Agent reply words</p>
      <a href="https://example.com/docs">docs link</a>
      <a href={createNativeChatFileHref('src/app.ts')}>app file</a>
      <div data-native-chat-rewind-item="ask-1">
        <p>User prompt</p>
      </div>
      <section
        data-native-chat-child-transcript="child-worker"
        data-native-chat-inherit-link-context={childInheritsLinkContext ? 'true' : 'false'}
      >
        <a href="src/app.ts">child file</a>
        <div data-native-chat-rewind-item="ask-1">Child prompt</div>
      </section>
      <p>Empty area</p>
      <textarea aria-label="composer" />
      {menu}
    </div>
  )
}

function menuItemNames(): string[] {
  return screen.queryAllByRole('menuitem').map((item) => item.textContent ?? '')
}

async function rightClick(text: string): Promise<void> {
  fireEvent.contextMenu(screen.getByText(text))
  await screen.findByRole('menu')
}

beforeEach(() => {
  vi.stubGlobal('api', { ui: { writeClipboardText: mocks.writeClipboardText } })
  mocks.writeClipboardText.mockResolvedValue(undefined)
})

afterEach(() => {
  cleanup()
  window.getSelection()?.removeAllRanges()
  vi.unstubAllGlobals()
  vi.resetAllMocks()
})

describe('native chat right-click targets', () => {
  it('offers a web link the rows its click popover offers, and copies its address', async () => {
    render(<Chat onFind={vi.fn()} />)
    await rightClick('docs link')

    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy link' }))
    expect(mocks.writeClipboardText).toHaveBeenCalledWith('https://example.com/docs')

    await rightClick('docs link')
    expect(menuItemNames().slice(0, 3)).toEqual(['System Browser', 'Orca Browser', 'Copy link'])
    fireEvent.click(screen.getByRole('menuitem', { name: 'Orca Browser' }))
    expect(mocks.openRoutedHttpLink).toHaveBeenCalledWith('https://example.com/docs', {
      worktreeId: 'wt-1',
      sourceOwner: { kind: 'local' },
      modifierHeld: false,
      forceDestination: 'orca'
    })
  })

  it('opens and copies a file link at the path the chat resolves it to', async () => {
    render(<Chat onFind={vi.fn()} />)
    await rightClick('app file')

    fireEvent.click(screen.getByRole('menuitem', { name: 'Open file' }))
    expect(mocks.openDetectedFilePath).toHaveBeenCalledWith(
      '/repo/src/app.ts',
      null,
      null,
      expect.objectContaining({ worktreeId: 'wt-1', worktreePath: '/repo' })
    )

    await rightClick('app file')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy Path' }))
    expect(mocks.writeClipboardText).toHaveBeenCalledWith('/repo/src/app.ts')
  })

  it('quotes a reply selection into the composer, only where the composer takes text', async () => {
    const view = render(<Chat onFind={vi.fn()} />)
    window.getSelection()?.selectAllChildren(screen.getByText('Agent reply words'))
    await rightClick('Agent reply words')

    fireEvent.click(screen.getByRole('menuitem', { name: 'Add to chat' }))
    expect(mocks.appendText).toHaveBeenCalledWith('> Agent reply words\n\n')

    view.unmount()
    render(<Chat acceptsText={false} onFind={vi.fn()} />)
    window.getSelection()?.selectAllChildren(screen.getByText('Agent reply words'))
    await rightClick('Agent reply words')
    expect(menuItemNames()).not.toContain('Add to chat')
  })

  it('keeps a different-workspace child link and prompt from acting on the parent', async () => {
    const rewind = { disabledReason: null, request: vi.fn() }
    render(<Chat rewind={rewind} onFind={vi.fn()} />)
    await rightClick('child file')
    expect(menuItemNames()).not.toContain('Open file')
    expect(menuItemNames()).not.toContain('Copy Path')
    expect(mocks.openDetectedFilePath).not.toHaveBeenCalled()
    await rightClick('Child prompt')
    expect(menuItemNames()).not.toContain('Rewind to here')
    expect(rewind.request).not.toHaveBeenCalled()
  })

  it('preserves file actions for a child with the verified parent workspace scope', async () => {
    render(<Chat childInheritsLinkContext onFind={vi.fn()} />)
    await rightClick('child file')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open file' }))
    expect(mocks.openDetectedFilePath).toHaveBeenCalledWith(
      '/repo/src/app.ts',
      null,
      null,
      expect.objectContaining({ worktreeId: 'wt-1', worktreePath: '/repo' })
    )
  })

  it('rewinds to the right-clicked prompt through the confirm dialog', async () => {
    const rewind = { disabledReason: null, request: vi.fn() }
    render(<Chat rewind={rewind} />)
    await rightClick('User prompt')

    fireEvent.click(screen.getByRole('menuitem', { name: 'Rewind to here' }))
    expect(rewind.request).toHaveBeenCalledWith('ask-1', mocks.confirm)
  })

  it('shows rewind disabled with the reason its hover button gives', async () => {
    const rewind = { disabledReason: 'Wait for the reply to finish', request: vi.fn() }
    render(<Chat rewind={rewind} />)
    await rightClick('User prompt')

    const item = screen.getByRole('menuitem', { name: /Rewind to here/ })
    expect(item).toHaveAttribute('aria-disabled', 'true')
    expect(item).toHaveTextContent('Wait for the reply to finish')
    fireEvent.click(item)
    expect(rewind.request).not.toHaveBeenCalled()
  })

  it('offers no target rows on an empty part of the transcript', async () => {
    const rewind = { disabledReason: null, request: vi.fn() }
    render(<Chat rewind={rewind} onFind={vi.fn()} />)
    await rightClick('Empty area')

    expect(menuItemNames()).toEqual([expect.stringMatching(/^Find in chat/)])
  })

  it('opens find from the menu', async () => {
    const onFind = vi.fn()
    render(<Chat onFind={onFind} />)
    await rightClick('Empty area')

    fireEvent.click(screen.getByRole('menuitem', { name: /Find in chat/ }))
    expect(onFind).toHaveBeenCalledOnce()
  })

  it("runs the terminal pane's Copy Context and Clear Pane Title for a chat in a terminal pane", async () => {
    const onCopyAgentSessionContext = vi.fn()
    const onClearPaneTitle = vi.fn()
    const view = render(
      <Chat actions={{ onCopyAgentSessionContext, onClearPaneTitle, canClearPaneTitle: false }} />
    )
    await rightClick('Empty area')
    expect(menuItemNames()).not.toContain('Clear Pane Title')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy Context' }))
    expect(onCopyAgentSessionContext).toHaveBeenCalledOnce()

    view.rerender(
      <Chat actions={{ onCopyAgentSessionContext, onClearPaneTitle, canClearPaneTitle: true }} />
    )
    await rightClick('Empty area')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Clear Pane Title' }))
    expect(onClearPaneTitle).toHaveBeenCalledOnce()
  })
})

it.each([
  {
    firstText: 'docs link',
    firstCopy: 'Copy link',
    firstDestination: 'https://example.com/docs',
    nextText: 'app file',
    nextCopy: 'Copy Path',
    nextDestination: '/repo/src/app.ts',
    nextFirstRow: 'Open file'
  },
  {
    firstText: 'app file',
    firstCopy: 'Copy Path',
    firstDestination: '/repo/src/app.ts',
    nextText: 'docs link',
    nextCopy: 'Copy link',
    nextDestination: 'https://example.com/docs',
    nextFirstRow: 'System Browser'
  }
])(
  'keeps $nextCopy on rapid reopening after an earlier selection closes',
  async ({
    firstText,
    firstCopy,
    firstDestination,
    nextText,
    nextCopy,
    nextDestination,
    nextFirstRow
  }) => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    try {
      render(<Chat onFind={vi.fn()} />)
      await rightClick(firstText)
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      // Cross the dismissal guard, then reopen before Radix's queued close cleanup.
      clock.mockReturnValue(1_120)
      fireEvent.click(screen.getByRole('menuitem', { name: firstCopy }))
      expect(mocks.writeClipboardText).toHaveBeenCalledExactlyOnceWith(firstDestination)

      fireEvent.contextMenu(screen.getByText(nextText))
      await act(async () => {
        await vi.runOnlyPendingTimersAsync()
      })

      expect(menuItemNames()[0]).toBe(nextFirstRow)
      fireEvent.click(screen.getByRole('menuitem', { name: nextCopy }))
      expect(mocks.writeClipboardText).toHaveBeenNthCalledWith(2, nextDestination)
    } finally {
      cleanup()
      if (vi.isFakeTimers()) {
        await act(async () => {
          await vi.runOnlyPendingTimersAsync()
        })
      }
      vi.useRealTimers()
      clock.mockRestore()
    }
  }
)
