// @vitest-environment happy-dom

import { describe, expect, it, vi } from 'vitest'
import { TerminalKittyKeyboardModeTracker } from '../../../../shared/terminal-kitty-keyboard-mode-tracker'
import { openStandaloneTerminal } from './open-standalone-terminal'

let emitData: (data: string) => void = () => {}
let signalUserInput: () => void = () => {}

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    open(): void {}
    dispose(): void {}
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
  installPreviewTerminalCompatibility: () => () => {}
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
