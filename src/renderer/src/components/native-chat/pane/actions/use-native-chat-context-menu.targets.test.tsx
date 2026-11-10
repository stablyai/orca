// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { useRef } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type * as HttpLinkDestinations from '@/lib/browser/navigation/http-link-destinations'
import type * as TerminalFileOpenRouting from '@/components/terminal-pane/links/files/terminal-file-open-routing'
import { createNativeChatFileHref } from '../../../../../../shared/native-chat/native-chat-href-routing'
import type { NativeChatComposerHandle } from '../../composer/native-chat-composer-types'
import {
  emptyNativeChatContextMenuActions,
  useNativeChatContextMenu
} from './use-native-chat-context-menu'

const mocks = vi.hoisted(() => ({
  openRoutedHttpLink: vi.fn(),
  openDetectedFilePath: vi.fn(),
  writeClipboardText: vi.fn(),
  confirm: vi.fn(),
  appendText: vi.fn()
}))

vi.mock('@/lib/browser/navigation/http-link-destinations', async (importOriginal) => ({
  ...(await importOriginal<typeof HttpLinkDestinations>()),
  openRoutedHttpLink: mocks.openRoutedHttpLink
}))
vi.mock(
  '@/components/terminal-pane/links/files/terminal-file-open-routing',
  async (importOriginal) => ({
    ...(await importOriginal<typeof TerminalFileOpenRouting>()),
    openDetectedFilePath: mocks.openDetectedFilePath
  })
)
vi.mock('../../links/actions/native-chat-http-link-source-owner', () => ({
  resolveNativeChatHttpLinkSourceOwner: () => ({ kind: 'local' }),
  canNativeChatOpenOwnedBrowser: () => false
}))
vi.mock('@/components/confirmation-dialog-context', () => ({
  useConfirmationDialog: () => mocks.confirm
}))

const linkContext = { worktreeId: 'wt-1', worktreePath: '/repo', runtimeEnvironmentId: null }

function Chat({ onFind }: { onFind?: () => void }): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null)
  const composerRef = useRef<NativeChatComposerHandle | null>({
    focus: () => true,
    insertAgentReferences: () => false,
    insertTypedText: () => true,
    acceptsText: () => true,
    appendText: mocks.appendText,
    handlePasteEvent: () => {},
    pasteFromClipboard: () => {},
    contains: () => false
  })
  const { menu, onContextMenuCapture } = useNativeChatContextMenu({
    rootRef,
    composerRef,
    actions: { ...emptyNativeChatContextMenuActions, onPaste: vi.fn() },
    showTerminalPaneActions: false,
    fileLinkContext: linkContext,
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
