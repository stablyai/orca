// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react'
import { useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { APP_MENU_PASTE_EVENT } from '@/lib/app-menu-paste'
import { useNativeChatPasteBridge } from './use-native-chat-paste-bridge'
import type { NativeChatComposerHandle } from './NativeChatComposer'
import { NativeChatPaneCover } from '../terminal-pane/NativeChatPaneCover'
import { registerTerminalPanePasteListeners } from '../terminal-pane/terminal-pane-paste-listeners'
import type { TerminalPaneCloseController } from '../terminal-pane/use-terminal-pane-close-actions'
import type { TerminalPanePasteExecution } from '../terminal-pane/terminal-pane-paste-execution'
import {
  pasteTerminalPaneMenuClipboard,
  type TerminalPaneMenuPasteContext
} from '../terminal-pane/terminal-pane-menu-paste'
import type { ManagedPane } from '@/lib/pane-manager/pane-manager'

const mocks = vi.hoisted(() => ({
  readClipboardText: vi.fn(),
  terminalClipboard: vi.fn(),
  error: vi.fn()
}))
vi.mock('sonner', () => ({ toast: { error: mocks.error } }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('../terminal-pane/terminal-clipboard-paste', () => ({
  pasteTerminalClipboard: mocks.terminalClipboard
}))
vi.mock('../terminal-pane/terminal-clipboard-event-paste', () => ({
  isClipboardEventPasteRequired: () => false,
  firesNativePasteEvent: () => true,
  getClipboardEventText: (event: ClipboardEvent) => event.clipboardData?.getData('text/plain') ?? ''
}))

const REFUSAL = "Can't paste — this chat isn't accepting input right now."

let dispose: (() => void) | undefined
beforeEach(() => {
  mocks.readClipboardText.mockResolvedValue('menu text')
  mocks.terminalClipboard.mockResolvedValue({ status: 'empty' })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { ui: { readClipboardText: mocks.readClipboardText } }
  })
})
afterEach(() => {
  cleanup()
  dispose?.()
  dispose = undefined
  document.body.replaceChildren()
  vi.clearAllMocks()
})

type FakePane = Pick<ManagedPane, 'id' | 'container' | 'terminal'> & {
  helper: HTMLTextAreaElement
}

function terminalPane(id: number): FakePane {
  const container = document.createElement('div')
  container.className = 'pane'
  container.dataset.leafId = `leaf-${id}`
  const element = document.createElement('div')
  element.className = 'xterm'
  const helper = document.createElement('textarea')
  helper.className = 'xterm-helper-textarea'
  element.append(helper)
  container.append(element)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: cover code reads only element and focus.
  const terminal = { element, focus: () => helper.focus() } as unknown as ManagedPane['terminal']
  return { id, container, terminal, helper }
}

function composerHandle(): NativeChatComposerHandle & { element: HTMLElement } {
  const element = document.createElement('div')
  element.contentEditable = 'true'
  // Production marks the composer field box and the pane-wide drop surface alike.
  element.dataset.composerScopeKey = 'pane'
  return {
    element,
    focus: vi.fn(() => {
      element.focus()
      return true
    }),
    insertTypedText: vi.fn(() => true),
    handlePasteEvent: vi.fn(),
    pasteFromClipboard: vi.fn(),
    contains: (node) => element.contains(node)
  }
}

type ChatOptions = {
  composer?: NativeChatComposerHandle & { element: HTMLElement }
  answer?: HTMLInputElement
  answerRef?: { current: HTMLInputElement | null }
}

function ChatRoot({
  composer,
  answer,
  answerRef: sharedAnswerRef
}: ChatOptions): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null)
  const composerRef = useRef<NativeChatComposerHandle | null>(composer ?? null)
  const ownAnswerRef = useRef<HTMLInputElement | null>(answer ?? null)
  const answerRef = sharedAnswerRef ?? ownAnswerRef
  useNativeChatPasteBridge({ rootRef, composerRef, questionAnswerInputRef: answerRef })
  return (
    // Mirrors NativeChatPaneFileDropSurface, which publishes the composer scope pane-wide.
    <div data-composer-scope-key="pane" data-native-file-drop-target="composer">
      <div
        ref={(node) => {
          rootRef.current = node
          if (node && composer && !node.contains(composer.element)) {
            node.append(composer.element)
          }
          if (node && answer && !node.contains(answer)) {
            node.append(answer)
          }
        }}
        data-native-chat-root="true"
        tabIndex={-1}
      >
        <p data-testid="transcript">transcript</p>
        <input data-testid="search" />
      </div>
    </div>
  )
}

function Cover({
  pane,
  covered,
  children
}: {
  pane: FakePane
  covered: boolean
  children?: ReactNode
}): React.JSX.Element | null {
  return covered
    ? createPortal(
        <NativeChatPaneCover pane={pane}>{children}</NativeChatPaneCover>,
        pane.container
      )
    : null
}

function fixture(options: { platform?: NodeJS.Platform } = {}) {
  const container = document.createElement('div')
  const pane = terminalPane(1)
  const sibling = terminalPane(2)
  container.append(pane.container, sibling.container)
  const outside = document.createElement('input')
  document.body.append(container, outside)
  const pasteFromClipboard = vi.fn()
  const executePanePasteText = vi.fn()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the listeners use only these controller fields.
  const controller = {
    forceBracketedMultilineTextPaste: false,
    keybindings: {},
    worktreeId: 'workspace',
    tabId: 'tab',
    managerRef: { current: { getActivePane: () => pane, getPanes: () => [pane, sibling] } },
    paneTransportsRef: { current: new Map() },
    setTerminalError: vi.fn()
  } as unknown as TerminalPaneCloseController
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these are the two execution callbacks read by the listener.
  const execution = {
    pasteFromClipboard,
    executePanePasteText
  } as unknown as TerminalPanePasteExecution
  dispose = registerTerminalPanePasteListeners({
    container,
    controller,
    execution,
    isMac: options.platform === 'darwin',
    shortcutPlatform: options.platform ?? 'win32'
  })
  pane.helper.focus()
  const view = render(<Cover pane={pane} covered={false} />)
  const cover = (chat: ReactNode = null): void =>
    view.rerender(
      <Cover pane={pane} covered>
        {chat}
      </Cover>
    )
  const uncover = (): void => view.rerender(<Cover pane={pane} covered={false} />)
  const shell = (): HTMLElement => {
    const element = pane.container.querySelector<HTMLElement>('.native-chat-pane-shell')
    if (!element) {
      throw new Error('cover not mounted')
    }
    return element
  }
  return { pane, sibling, outside, pasteFromClipboard, cover, uncover, shell }
}

function paste(target: Element, text = 'event text'): ClipboardEvent {
  const data = new DataTransfer()
  data.setData('text/plain', text)
  const event = new ClipboardEvent('paste', {
    clipboardData: data,
    bubbles: true,
    cancelable: true
  })
  target.dispatchEvent(event)
  return event
}

function menuPane(pane: FakePane): ManagedPane {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a covered pane's menu paste reads only container and terminal.
  return pane as unknown as ManagedPane
}

function menuContext(): TerminalPaneMenuPasteContext {
  return {
    managerRef: { current: null },
    paneTransportsRef: { current: new Map() },
    tabId: 'tab',
    worktreeId: 'workspace',
    forceBracketedMultilineTextPaste: false,
    onPasteError: vi.fn()
  }
}

describe('a chat cover owns focus over its terminal', () => {
  it('moves focus off the covered xterm and keeps it off', () => {
    const f = fixture()
    expect(document.activeElement).toBe(f.pane.helper)
    f.cover()
    expect(document.activeElement).toBe(f.shell())
    expect(f.pane.terminal.element?.inert).toBe(true)
    // Any of the unguarded terminal.focus() paths (focus-follows-mouse, pane menus) now no-ops.
    f.pane.terminal.focus()
    expect(document.activeElement).toBe(f.shell())
  })

  it('leaves a split sibling focusable', () => {
    const f = fixture()
    f.cover()
    expect(f.sibling.terminal.element?.inert).toBe(false)
    f.sibling.terminal.focus()
    expect(document.activeElement).toBe(f.sibling.helper)
  })

  it('does not pull focus from elsewhere when a chat opens', () => {
    const f = fixture()
    f.outside.focus()
    f.cover()
    expect(document.activeElement).toBe(f.outside)
    expect(f.pane.terminal.element?.inert).toBe(true)
  })

  it('returns focus to the terminal when the chat that held it goes away', () => {
    const f = fixture()
    f.cover()
    f.uncover()
    expect(f.pane.terminal.element?.inert).toBe(false)
    expect(document.activeElement).toBe(f.pane.helper)
  })

  it.each(['another control', 'nothing'] as const)(
    'does not pull focus into the terminal when %s had focus',
    (holder) => {
      const f = fixture()
      f.cover()
      if (holder === 'another control') {
        f.outside.focus()
      } else {
        f.shell().blur()
      }
      const focusedBefore = document.activeElement
      f.uncover()
      expect(f.pane.terminal.element?.inert).toBe(false)
      expect(document.activeElement).toBe(focusedBefore)
    }
  )
})

describe('paste inside a chat cover never reaches the terminal', () => {
  it.each(['darwin', 'win32', 'linux'] as const)(
    'refuses a %s paste before the chat has mounted any input',
    (platform) => {
      const f = fixture({ platform })
      f.cover()
      f.shell().dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'v',
          metaKey: platform === 'darwin',
          ctrlKey: platform !== 'darwin',
          bubbles: true,
          cancelable: true
        })
      )
      expect(paste(f.shell()).defaultPrevented).toBe(true)
      expect(f.pasteFromClipboard).not.toHaveBeenCalled()
      expect(mocks.error).toHaveBeenCalledExactlyOnceWith(REFUSAL)
    }
  )

  it('leaves the app-menu paste to the cover instead of the hidden terminal', () => {
    const f = fixture({ platform: 'darwin' })
    f.cover()
    const event = new Event(APP_MENU_PASTE_EVENT, { cancelable: true })
    window.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
    expect(mocks.terminalClipboard).not.toHaveBeenCalled()
  })

  it('refuses when the chat shows no input, such as an approval card', () => {
    const f = fixture()
    f.cover(<ChatRoot />)
    const transcript = f.pane.container.querySelector('[data-testid="transcript"]')!
    expect(paste(transcript).defaultPrevented).toBe(true)
    expect(mocks.error).toHaveBeenCalledExactlyOnceWith(REFUSAL)
    expect(f.pasteFromClipboard).not.toHaveBeenCalled()
  })

  it('hands a paste on the cover itself to the composer once the chat mounts', () => {
    const f = fixture()
    const composer = composerHandle()
    f.cover(<ChatRoot composer={composer} />)
    paste(f.shell())
    expect(composer.pasteFromClipboard).toHaveBeenCalledTimes(1)
    expect(mocks.error).not.toHaveBeenCalled()
    expect(f.pasteFromClipboard).not.toHaveBeenCalled()
  })

  it('delivers transcript paste with its payload to the composer', () => {
    const f = fixture()
    const composer = composerHandle()
    f.cover(<ChatRoot composer={composer} />)
    const transcript = f.pane.container.querySelector('[data-testid="transcript"]')!
    const event = paste(transcript, '원문')
    expect(composer.handlePasteEvent).toHaveBeenCalledExactlyOnceWith(event)
    expect(mocks.readClipboardText).not.toHaveBeenCalled()
    expect(mocks.error).not.toHaveBeenCalled()
  })

  it('keeps native paste in a text field inside the chat despite the pane-wide scope marker', () => {
    const f = fixture()
    const composer = composerHandle()
    f.cover(<ChatRoot composer={composer} />)
    const search = f.pane.container.querySelector<HTMLInputElement>('[data-testid="search"]')!
    expect(paste(search).defaultPrevented).toBe(false)
    search.focus()
    window.dispatchEvent(new Event(APP_MENU_PASTE_EVENT, { cancelable: true }))
    expect(composer.handlePasteEvent).not.toHaveBeenCalled()
    expect(composer.pasteFromClipboard).not.toHaveBeenCalled()
    expect(mocks.error).not.toHaveBeenCalled()
  })

  it('claims the app-menu paste while the composer input has focus', () => {
    const f = fixture({ platform: 'darwin' })
    const composer = composerHandle()
    f.cover(<ChatRoot composer={composer} />)
    composer.element.focus()
    window.dispatchEvent(new Event(APP_MENU_PASTE_EVENT, { cancelable: true }))
    expect(composer.pasteFromClipboard).toHaveBeenCalledTimes(1)
    expect(mocks.terminalClipboard).not.toHaveBeenCalled()
  })

  it('hands transcript paste to the question answer when the composer is absent', async () => {
    const f = fixture()
    const answer = document.createElement('input')
    f.cover(<ChatRoot answer={answer} />)
    const transcript = f.pane.container.querySelector('[data-testid="transcript"]')!
    await act(async () => {
      paste(transcript, 'answer')
    })
    expect(answer.value).toBe('answer')
    expect(mocks.error).not.toHaveBeenCalled()
  })

  it('keeps terminal-only paste unchanged', () => {
    const f = fixture()
    paste(f.pane.helper)
    expect(f.pasteFromClipboard).toHaveBeenCalledExactlyOnceWith(f.pane, 'paste-event')
    window.dispatchEvent(new Event(APP_MENU_PASTE_EVENT, { cancelable: true }))
    expect(mocks.terminalClipboard).toHaveBeenCalledTimes(1)
  })
})

describe('terminal context-menu paste on a covered pane', () => {
  it('routes by its named pane to that pane’s chat', async () => {
    const f = fixture()
    const composer = composerHandle()
    f.cover(<ChatRoot composer={composer} />)
    await pasteTerminalPaneMenuClipboard(menuContext(), menuPane(f.pane), 'context-menu')
    expect(composer.pasteFromClipboard).toHaveBeenCalledTimes(1)
    expect(mocks.terminalClipboard).not.toHaveBeenCalled()
  })

  it('refuses instead of pasting into the terminal when the chat has no input', async () => {
    const f = fixture()
    f.cover()
    await pasteTerminalPaneMenuClipboard(menuContext(), menuPane(f.pane), 'right-click')
    expect(mocks.error).toHaveBeenCalledExactlyOnceWith(REFUSAL)
    expect(mocks.terminalClipboard).not.toHaveBeenCalled()
  })

  it('does not put a late read into a replacement question input', async () => {
    const f = fixture()
    const answer = document.createElement('input')
    const answerRef = { current: answer }
    f.cover(<ChatRoot answer={answer} answerRef={answerRef} />)
    let finish = (_text: string): void => {}
    mocks.readClipboardText.mockReturnValue(
      new Promise<string>((resolve) => {
        finish = resolve
      })
    )
    await pasteTerminalPaneMenuClipboard(menuContext(), menuPane(f.pane), 'context-menu')
    answerRef.current = document.createElement('input')
    await act(async () => finish('old answer'))
    expect(answer.value).toBe('')
    expect(answerRef.current.value).toBe('')
  })
})
