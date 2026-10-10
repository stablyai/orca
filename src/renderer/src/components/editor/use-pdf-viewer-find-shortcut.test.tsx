// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react'
import { useContext, useRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EditorCommandOwnerContext } from './editor-command-owner-context'
import { usePdfViewerFindShortcut } from './use-pdf-viewer-find-shortcut'
import { useNativeChatFind } from '../native-chat/use-native-chat-find'

vi.mock('@/store', () => ({ useAppStore: { getState: () => ({ keybindings: undefined }) } }))
vi.mock('../../store', () => ({ useAppStore: { getState: () => ({ keybindings: undefined }) } }))
vi.mock('@/lib/web-client-location', () => ({ isWebClientLocation: () => false }))

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
})

function pressFind(target: EventTarget): KeyboardEvent {
  const isMac = navigator.userAgent.includes('Mac')
  const event = new KeyboardEvent('keydown', {
    key: 'f',
    code: 'KeyF',
    bubbles: true,
    cancelable: true,
    metaKey: isMac,
    ctrlKey: !isMac
  })
  target.dispatchEvent(event)
  return event
}

function PdfViewerStandIn({
  name,
  openFind
}: {
  name: string
  openFind: () => void
}): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null)
  const ownsCommands = useContext(EditorCommandOwnerContext)
  usePdfViewerFindShortcut({ rootRef, ownsCommands, keybindings: undefined, openFind })
  return (
    <div ref={rootRef} data-testid={`${name}-pdf`}>
      <canvas />
    </div>
  )
}

/** The real split shape: each group's strip and body (where editors render), and the retained
 *  overlay host for terminals, chats and browsers as a sibling of the layout, outside every body. */
function Workspace({
  focusedGroup,
  openFind
}: {
  focusedGroup: 'pdf' | 'chat' | 'second-pdf' | null
  openFind: Record<'pdf' | 'second-pdf', () => void>
}): React.JSX.Element {
  return (
    <div>
      <div data-tab-group-strip-id="pdf">
        <div tabIndex={0} data-testid="pdf-tab" />
      </div>
      <div data-tab-group-body-id="pdf">
        <EditorCommandOwnerContext value={focusedGroup === 'pdf'}>
          <button type="button" data-testid="pdf-header-copy-path" />
          <PdfViewerStandIn name="first" openFind={openFind.pdf} />
        </EditorCommandOwnerContext>
      </div>
      <div data-tab-group-body-id="second-pdf">
        <EditorCommandOwnerContext value={focusedGroup === 'second-pdf'}>
          <PdfViewerStandIn name="second" openFind={openFind['second-pdf']} />
        </EditorCommandOwnerContext>
      </div>
      <div data-tab-group-strip-id="chat" />
      <div data-tab-group-body-id="chat" />
      <div data-testid="retained-overlays">
        <div data-native-chat-root="true">
          <button type="button" data-testid="chat-tool-disclosure" />
        </div>
        <textarea className="xterm-helper-textarea" data-testid="xterm" />
        <button type="button" data-testid="browser-chrome" />
      </div>
      <button type="button" data-testid="explorer-row" />
      <input data-testid="sidebar-search" />
    </div>
  )
}

function setup(focusedGroup: 'pdf' | 'chat' | 'second-pdf' | null) {
  const openFind = { pdf: vi.fn(), 'second-pdf': vi.fn() }
  const view = render(<Workspace focusedGroup={focusedGroup} openFind={openFind} />)
  return { openFind, view }
}

describe('PDF viewer find shortcut', () => {
  it('leaves Mod+F to a chat, terminal or browser whose split is focused', () => {
    const { openFind, view } = setup('chat')
    for (const id of ['chat-tool-disclosure', 'xterm', 'browser-chrome', 'explorer-row']) {
      expect(pressFind(view.getByTestId(id)).defaultPrevented).toBe(false)
    }
    expect(openFind.pdf).not.toHaveBeenCalled()
    expect(openFind['second-pdf']).not.toHaveBeenCalled()
  })

  it('opens from its own tab, its editor header and the file explorer while its group is focused', () => {
    const { openFind, view } = setup('pdf')
    for (const id of ['pdf-tab', 'pdf-header-copy-path', 'explorer-row']) {
      expect(pressFind(view.getByTestId(id)).defaultPrevented).toBe(true)
    }
    expect(pressFind(document.body).defaultPrevented).toBe(true)
    expect(openFind.pdf).toHaveBeenCalledTimes(4)
    // With two PDFs on screen only the focused group's opens.
    expect(openFind['second-pdf']).not.toHaveBeenCalled()
  })

  it('leaves a text field its keys, and always opens from inside the PDF', () => {
    const { openFind, view } = setup('chat')
    expect(pressFind(view.getByTestId('sidebar-search')).defaultPrevented).toBe(false)
    expect(pressFind(view.getByTestId('second-pdf').firstElementChild!).defaultPrevented).toBe(true)
    expect(openFind['second-pdf']).toHaveBeenCalledTimes(1)
    expect(openFind.pdf).not.toHaveBeenCalled()
  })

  it('does not open for a PDF kept mounted in a hidden workspace', () => {
    // A hidden workspace's groups are never the focused group.
    const { openFind } = setup(null)
    expect(pressFind(document.body).defaultPrevented).toBe(false)
    expect(openFind.pdf).not.toHaveBeenCalled()
  })
  it('answers only keys from its own window surface, not the floating workspace panel', () => {
    function Chat({ testId }: { testId: string }): React.JSX.Element {
      const rootRef = useRef<HTMLDivElement>(null)
      const composerRef = useRef(null)
      const listRef = useRef(null)
      const find = useNativeChatFind(true, rootRef, composerRef, listRef)
      return (
        <div ref={rootRef} tabIndex={-1} data-native-chat-root="true" data-testid={testId}>
          {find.isOpen ? <div data-testid={`${testId}-find`} /> : null}
        </div>
      )
    }
    const mainPdf = vi.fn()
    const floatingPdf = vi.fn()
    // Each surface keeps its own focused group: `owns` names the surfaces whose PDF group is focused.
    const surfaces = (owns: 'main' | 'floating'): React.JSX.Element => (
      <div>
        <div data-tab-group-body-id="main">
          <EditorCommandOwnerContext value={owns === 'main'}>
            <PdfViewerStandIn name="main" openFind={mainPdf} />
          </EditorCommandOwnerContext>
        </div>
        <Chat testId="main-chat" />
        <div data-floating-terminal-panel="">
          <div data-tab-group-body-id="floating">
            <EditorCommandOwnerContext value={owns === 'floating'}>
              <PdfViewerStandIn name="floating" openFind={floatingPdf} />
            </EditorCommandOwnerContext>
          </div>
          <Chat testId="floating-chat" />
        </div>
      </div>
    )
    // The main window's PDF group is focused; the panel's focused group is its chat.
    const view = render(surfaces('main'))
    const floatingChat = view.getByTestId('floating-chat')
    floatingChat.focus()
    act(() => {
      pressFind(floatingChat)
    })
    expect(mainPdf).not.toHaveBeenCalled()
    expect(view.queryByTestId('floating-chat-find')).not.toBeNull()

    // And the reverse: the panel's PDF group is focused; the main window's focused group is its chat.
    view.rerender(surfaces('floating'))
    const mainChat = view.getByTestId('main-chat')
    mainChat.focus()
    act(() => {
      pressFind(mainChat)
    })
    expect(floatingPdf).not.toHaveBeenCalled()
    expect(view.queryByTestId('main-chat-find')).not.toBeNull()
  })
})
