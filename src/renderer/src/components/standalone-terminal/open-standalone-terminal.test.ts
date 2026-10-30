// @vitest-environment happy-dom

import { describe, expect, it, vi } from 'vitest'
import { TerminalKittyKeyboardModeTracker } from '../../../../shared/terminal-kitty-keyboard-mode-tracker'
import { createPtyInputSourceBinding } from '../terminal-pane/pty-input-source'
import { installTerminalLinkPtyMouseSuppression } from '../terminal-pane/terminal-link-pty-mouse-suppression'
import { openStandaloneTerminal } from './open-standalone-terminal'

let emitData: (data: string) => void = () => {}
let signalUserInput: () => void = () => {}

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    element: HTMLElement | undefined
    open(container: HTMLElement): void {
      this.element = container
    }
    dispose(): void {
      emitData = () => {}
    }
    reset(): void {}
    clearSelection(): void {}
    write(_data: string, done?: () => void): void {
      done?.()
    }
    onData(listener: (data: string) => void): { dispose: () => void } {
      emitData = listener
      return { dispose: () => {} }
    }
  }
}))
vi.mock('@xterm/xterm/css/xterm.css', () => ({}))
vi.mock('@/components/terminal-pane/terminal-user-input-signal', () => ({
  subscribeToTerminalUserInput: (_terminal: unknown, listener: () => void) => {
    signalUserInput = listener
    return { dispose: () => {} }
  }
}))
vi.mock('@/components/terminal-pane/terminal-native-copy-gutter', () => ({
  installTerminalNativeCopyGutterTrim: () => ({ dispose: () => {} })
}))
vi.mock('../dashboard-popout/preview-terminal-compatibility', () => ({
  installPreviewTerminalCompatibility: (terminal: {
    element: HTMLElement
    clearSelection: () => void
  }) => {
    const inputOwner = installTerminalLinkPtyMouseSuppression(terminal, {
      candidate: () => 'fixture-link',
      eligible: () => true,
      canContinue: () => true
    })
    return Object.assign(() => inputOwner.dispose(), { inputOwner })
  }
}))
vi.mock('../dashboard-popout/preview-terminal-ime-bridge', () => ({
  installPreviewImeBridge: () => ({ claimKeyEvent: () => false, dispose: () => {} })
}))
vi.mock('../dashboard-popout/preview-terminal-key-handler', () => ({
  installPreviewTerminalKeyHandler: () => () => {}
}))
vi.mock('../dashboard-popout/preview-terminal-app-menu-clipboard', () => ({
  installPreviewTerminalAppMenuClipboard: () => () => {}
}))
vi.mock('../dashboard-popout/preview-terminal-right-click-paste', () => ({
  installPreviewTerminalRightClickPaste: () => () => {}
}))

function open(answersQueries: boolean): ReturnType<typeof vi.fn> {
  const sendInput = vi.fn(() => true)
  openStandaloneTerminal({
    container: document.createElement('div'),
    options: {},
    kittyKeyboardModes: new TerminalKittyKeyboardModeTracker(),
    sessionKey: 's',
    sendInput,
    answersQueries,
    getSettings: () => null,
    getMacOptionAsAlt: () => 'false',
    getTerminalInput: () => null
  })
  return sendInput
}

const CURSOR_POSITION_REPLY = '\u001b[5;1R'

describe('standalone terminal input', () => {
  it('forwards the user’s typing either way', () => {
    const sendInput = open(false)
    signalUserInput()
    emitData('ls\r')
    expect(sendInput).toHaveBeenCalledWith('ls\r')
  })

  it('preserves a real-input mouse report for a mouse-aware child', () => {
    const sendInput = open(false)
    signalUserInput()
    emitData('\x1b[<0;1;1M')
    expect(sendInput).toHaveBeenCalledExactlyOnceWith('\x1b[<0;1;1M')
  })

  it('leaves query replies to the real pane when it only mirrors one', () => {
    const sendInput = open(false)
    emitData(CURSOR_POSITION_REPLY)
    expect(sendInput).not.toHaveBeenCalled()
  })

  it('answers queries when it is the session’s only emulator', () => {
    const sendInput = open(true)
    emitData(CURSOR_POSITION_REPLY)
    expect(sendInput).toHaveBeenCalledWith(CURSOR_POSITION_REPLY)
  })
})

it.each([false, true])(
  'keeps the actual standalone onData/source/disposal route with answersQueries=%s',
  (answersQueries) => {
    const writes: string[] = []
    const sources = createPtyInputSourceBinding<string>({
      same: (a, b) => a === b,
      refine: (_, next) => next,
      create: (endpoint, isCurrent) => ({
        ptyId: endpoint(),
        isCurrent,
        sendInput: (data) => {
          if (!isCurrent()) {
            return false
          }
          writes.push(`${endpoint()}:${data}`)
          return true
        },
        sendInputImmediate: () => false
      })
    })
    sources.change('A', () => {})
    const container = document.createElement('div')
    const ordinary = vi.fn(() => true)
    const terminal = openStandaloneTerminal({
      container,
      options: {},
      kittyKeyboardModes: new TerminalKittyKeyboardModeTracker(),
      sessionKey: 'source',
      sendInput: ordinary,
      inputSource: { getInputSource: sources.current, observeInputSource: sources.observe },
      answersQueries,
      getSettings: () => null,
      getMacOptionAsAlt: () => 'false',
      getTerminalInput: () => null
    })
    if (!terminal) {
      throw new Error('missing standalone')
    }
    const down = '\x1b[<0;1;1M'
    const up = '\x1b[<0;1;1m'
    container.addEventListener('mousedown', () => {
      signalUserInput()
      emitData(down)
    })
    container.addEventListener('mouseup', () => {
      signalUserInput()
      emitData(up)
    })
    container.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, buttons: 1 }))
    sources.change('B', () => {})
    container.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    expect(writes).toEqual([`A:${down}`])
    expect(ordinary).not.toHaveBeenCalled()
    emitData(CURSOR_POSITION_REPLY)
    expect(ordinary).toHaveBeenCalledTimes(answersQueries ? 1 : 0)
    signalUserInput()
    emitData('ordinary-before-connect')
    expect(ordinary).toHaveBeenLastCalledWith('ordinary-before-connect')
    container.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, buttons: 1 }))
    terminal.dispose()
    expect(writes).toEqual([`A:${down}`, `B:${down}`])
    container.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    emitData('disposed')
    expect(ordinary).not.toHaveBeenCalledWith('disposed')
  }
)
