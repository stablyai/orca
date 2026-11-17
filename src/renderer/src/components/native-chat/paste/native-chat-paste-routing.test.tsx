// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react'
import { useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as I18nModule from '@/i18n/i18n'

import { useNativeChatPasteBridge } from './use-native-chat-paste-bridge'
import type { NativeChatComposerHandle } from '../composer/native-chat-composer-types'
import { NativeChatPaneCover } from '../../terminal-pane/chat/NativeChatPaneCover'

import { registerTerminalPanePasteListeners } from '../../terminal-pane/input/paste/terminal-pane-paste-listeners'
import type { TerminalPaneCloseController } from '../../terminal-pane/layout/close/use-terminal-pane-close-actions'
import type { TerminalPanePasteExecution } from '../../terminal-pane/input/paste/terminal-pane-paste-execution'
import { createClipboardImagePasteEnterHold } from '../../terminal-pane/input/paste/clipboard-image-paste-enter-hold'
import {
  pasteTerminalPaneMenuClipboard,
  type TerminalPaneMenuPasteContext
} from '../../terminal-pane/input/paste/terminal-pane-menu-paste'
import type { ManagedPane } from '@/lib/pane-manager/pane-manager-types'

const mocks = vi.hoisted(() => ({
  readClipboardText: vi.fn(),
  terminalClipboard: vi.fn(),
  error: vi.fn()
}))
vi.mock('sonner', () => ({ toast: { error: mocks.error } }))
vi.mock('@/i18n/i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof I18nModule>()),
  translate: (_key: string, fallback: string) => fallback
}))
vi.mock('../../terminal-pane/clipboard/terminal-clipboard-paste', () => ({
  pasteTerminalClipboard: mocks.terminalClipboard
}))
vi.mock('../../terminal-pane/clipboard/terminal-clipboard-event-paste', () => ({
  isClipboardEventPasteRequired: () => false,
  firesNativePasteEvent: () => true,
  getClipboardEventText: (event: ClipboardEvent) => event.clipboardData?.getData('text/plain') ?? ''
}))

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
    <div data-composer-scope-key="pane">
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
    managerRef: { current: { getActivePane: () => pane, getPanes: () => [pane, sibling] } },
    paneTransportsRef: { current: new Map() },
    setTerminalError: vi.fn()
  } as unknown as TerminalPaneCloseController
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these are the execution callbacks read by the listener.
  const execution = {
    pasteFromClipboard,
    executePanePasteText,
    resolvePaneProtectedMultilinePasteOptions: () => undefined,
    clipboardImageEnterHold: createClipboardImagePasteEnterHold({ getPanes: () => undefined })
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
    onPasteError: vi.fn(),
    clipboardImageEnterHold: createClipboardImagePasteEnterHold({ getPanes: () => undefined })
  }
}

describe('paste inside a chat cover never reaches the terminal', () => {
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
})

describe('terminal context-menu paste on a covered pane', () => {
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
