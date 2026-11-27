import { Terminal } from '@xterm/xterm'
import { vi } from 'vitest'
import { TerminalKittyKeyboardModeTracker } from '../../../../../shared/terminal/protocol/input-modes/terminal-kitty-keyboard-mode-tracker'
import { installTerminalPaneInputHandling } from './terminal-pane-pane-input'

export async function openKittyPane(
  pushKittyFlags = '\x1b[>7u'
): Promise<{ sent: string[]; textarea: HTMLTextAreaElement }> {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: xterm's DOM renderer only calls measureText on this context.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    measureText: () => ({ width: 10 })
  } as unknown as CanvasRenderingContext2D)
  const container = document.createElement('div')
  document.body.appendChild(container)
  const terminal = new Terminal({ vtExtensions: { kittyKeyboard: true } })
  terminal.open(container)
  const textarea = terminal.textarea
  if (!textarea) {
    throw new Error('xterm helper textarea was not created')
  }
  const kittyModes = new TerminalKittyKeyboardModeTracker()
  kittyModes.scan(pushKittyFlags)
  await new Promise<void>((resolve) => terminal.write(pushKittyFlags, resolve))
  installTerminalPaneInputHandling({
    pane: { id: 1, terminal },
    managerRef: { current: null },
    paneKittyKeyboardModesRef: { current: new Map([[1, kittyModes]]) },
    settingsRef: { current: null },
    imeCompositionDisposablesRef: { current: new Map() },
    imeNativeTextForwarderDisposablesRef: { current: new Map() }
  })
  const sent: string[] = []
  terminal.onData((data) => sent.push(data))
  return { sent, textarea }
}
