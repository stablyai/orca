// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { NATIVE_CHAT_PASTE_REQUEST_EVENT } from '@/lib/native-chat-paste-request'
import { registerTerminalPanePasteListeners } from './terminal-pane-paste-listeners'
import type { TerminalPanePasteExecution } from './terminal-pane-paste-execution'
import type { TerminalPaneCloseController } from './use-terminal-pane-close-actions'

let cleanup: (() => void) | null = null
afterEach(() => {
  cleanup?.()
  cleanup = null
  document.body.replaceChildren()
})

/** A tab whose one pane has xterm's textarea and, optionally, the chat portaled over it. */
function mountPane(withChat: boolean) {
  const container = document.createElement('div')
  const paneContainer = document.createElement('div')
  const xtermTextarea = document.createElement('textarea')
  xtermTextarea.className = 'xterm-helper-textarea'
  paneContainer.append(xtermTextarea)
  const onChatPasteRequest = vi.fn((event: Event) => event.preventDefault())
  if (withChat) {
    const chatRoot = document.createElement('div')
    chatRoot.dataset.nativeChatRoot = 'true'
    chatRoot.addEventListener(NATIVE_CHAT_PASTE_REQUEST_EVENT, onChatPasteRequest)
    paneContainer.append(chatRoot)
  }
  container.append(paneContainer)
  document.body.append(container)
  const pane = { id: 1, leafId: 'leaf-1', container: paneContainer }
  const pasteFromClipboard = vi.fn()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the paste listeners read only these controller fields.
  const controller = {
    forceBracketedMultilineTextPaste: false,
    keybindings: {},
    managerRef: { current: { getActivePane: () => pane, getPanes: () => [pane] } },
    setTerminalError: vi.fn(),
    worktreeId: 'wt-1'
  } as unknown as TerminalPaneCloseController
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only pasteFromClipboard is reachable from a paste event.
  const execution = {
    executePanePasteText: vi.fn(),
    pasteFromClipboard
  } as unknown as TerminalPanePasteExecution
  cleanup = registerTerminalPanePasteListeners({
    container,
    controller,
    execution,
    isMac: false,
    shortcutPlatform: 'win32'
  })
  return { xtermTextarea, pasteFromClipboard, onChatPasteRequest }
}

function pasteInto(target: Element): Event {
  const event = new Event('paste', { bubbles: true, cancelable: true })
  target.dispatchEvent(event)
  return event
}

describe('terminal paste under a chat overlay', () => {
  it('hands a paste caught by xterm’s textarea to the chat over the pane', () => {
    const { xtermTextarea, pasteFromClipboard, onChatPasteRequest } = mountPane(true)
    expect(pasteInto(xtermTextarea).defaultPrevented).toBe(true)
    expect(onChatPasteRequest).toHaveBeenCalledTimes(1)
    expect(pasteFromClipboard).not.toHaveBeenCalled()
  })

  it('pastes into the terminal when no chat overlays it', () => {
    const { xtermTextarea, pasteFromClipboard } = mountPane(false)
    pasteInto(xtermTextarea)
    expect(pasteFromClipboard).toHaveBeenCalledTimes(1)
  })
})
