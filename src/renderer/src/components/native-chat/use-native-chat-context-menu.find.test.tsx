// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { useRef } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { NativeChatFindBar } from './NativeChatFindBar'
import { NativeChatQueuedMessageEditor } from './NativeChatQueuedMessageEditor'
import type { NativeChatComposerHandle } from './native-chat-composer-types'
import {
  emptyNativeChatContextMenuActions,
  useNativeChatContextMenu
} from './use-native-chat-context-menu'
import { useNativeChatFind } from './use-native-chat-find'
import { useNativeChatRootInputRouting } from './use-native-chat-root-input-routing'

function Chat(): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null)
  const questionAnswerInputRef = useRef<HTMLInputElement>(null)
  const composerElementRef = useRef<HTMLTextAreaElement>(null)
  const composerRef = useRef<NativeChatComposerHandle>({
    focus: () => {
      composerElementRef.current?.focus()
      return true
    },
    insertTypedText: () => true,
    acceptsText: () => true,
    appendText: () => {},
    handlePasteEvent: () => {},
    pasteFromClipboard: () => {},
    contains: () => false
  })
  const messageListRef = useRef({ revealFindMatch: () => {} })
  const find = useNativeChatFind(true, rootRef, composerRef, messageListRef)
  const rootInput = useNativeChatRootInputRouting({
    tabId: 'chat-tab',
    rootRef,
    composerRef,
    questionAnswerInputRef,
    isVisible: true,
    isFocusedGroup: true,
    composerReady: true
  })
  const contextMenu = useNativeChatContextMenu({
    rootRef,
    composerRef,
    actions: { ...emptyNativeChatContextMenuActions, onPaste: () => {} },
    showTerminalPaneActions: false,
    onFind: find.open
  })
  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      onContextMenuCapture={contextMenu.onContextMenuCapture}
      onPointerDownCapture={(event) => {
        contextMenu.onPointerDownCapture(event)
        rootInput.onPointerDownCapture(event)
      }}
      onKeyDownCapture={(event) => {
        find.onKeyDownCapture(event)
        rootInput.onKeyDownCapture(event)
      }}
    >
      {find.isOpen ? <NativeChatFindBar find={find} isVisible /> : null}
      <div data-native-chat-scroll>
        <div data-native-chat-transcript-column>Transcript words</div>
      </div>
      <NativeChatQueuedMessageEditor
        editor={{
          messageId: 'queued-1',
          text: 'Queued draft',
          acquiring: false,
          saving: false,
          canSave: true,
          change: () => {},
          save: () => {},
          cancel: () => {}
        }}
      />
      <textarea aria-label="Composer" ref={composerElementRef} />
      {contextMenu.menu}
    </div>
  )
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

it.each([
  { gesture: 'right-click', userAgent: 'Windows', button: 2, ctrlKey: false },
  { gesture: 'macOS Ctrl-click', userAgent: 'Mac', button: 0, ctrlKey: true }
])(
  'returns to the queued-message editor after closing Find opened by $gesture',
  async ({ userAgent, button, ctrlKey }) => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(userAgent)
    const clock = vi.spyOn(Date, 'now').mockReturnValue(0)
    render(<Chat />)
    const editor = screen.getByRole('textbox', { name: 'Edit message' })
    expect(editor).toHaveFocus()

    const transcript = screen.getByText('Transcript words')
    fireEvent.pointerDown(transcript, { button, ctrlKey })
    fireEvent.contextMenu(transcript, { button, ctrlKey })
    const menu = await screen.findByRole('menu')
    await waitFor(() => expect(menu.contains(document.activeElement)).toBe(true))
    // The menu ignores dismissal during the press that opened it.
    clock.mockReturnValue(1000)
    fireEvent.click(screen.getByRole('menuitem', { name: /Find in chat/ }))
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument())

    const input = screen.getByRole('textbox', { name: 'Find in chat' })
    expect(input).toHaveFocus()
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(screen.queryByRole('search')).not.toBeInTheDocument()
    expect(editor).toHaveFocus()
  }
)
