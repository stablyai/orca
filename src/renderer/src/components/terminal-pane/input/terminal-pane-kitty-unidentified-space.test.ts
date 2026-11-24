// @vitest-environment happy-dom
import { Terminal } from '@xterm/xterm'
import { afterEach, expect, it, vi } from 'vitest'
import { TerminalKittyKeyboardModeTracker } from '../../../../../shared/terminal/protocol/input-modes/terminal-kitty-keyboard-mode-tracker'
import { installTerminalPaneInputHandling } from './terminal-pane-pane-input'

afterEach(() => {
  vi.restoreAllMocks()
  document.body.replaceChildren()
})

async function openKittyPane(
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

// The event Electron 43 delivers on Linux Wayland, as captured in #23215.
function dispatchUnidentifiedCtrlSpace(
  textarea: HTMLTextAreaElement,
  type: 'keydown' | 'keyup',
  isComposing = false
): void {
  const event = new KeyboardEvent(type, {
    key: 'Unidentified',
    code: 'Space',
    ctrlKey: true,
    bubbles: true,
    cancelable: true
  })
  Object.defineProperty(event, 'keyCode', { value: 32 })
  // happy-dom ignores KeyboardEventInit.isComposing, but Chromium reports it.
  Object.defineProperty(event, 'isComposing', { value: isComposing })
  textarea.dispatchEvent(event)
}

it('sends Ctrl+Space to a Kitty-keyboard app when Chromium names the key Unidentified (#23215)', async () => {
  const { sent, textarea } = await openKittyPane()

  dispatchUnidentifiedCtrlSpace(textarea, 'keydown')
  dispatchUnidentifiedCtrlSpace(textarea, 'keyup')

  expect(sent).toEqual(['\x1b[32;5u', '\x1b[32;5:3u'])
})

it('releases that Ctrl+Space when an IME starts composing before the keyup', async () => {
  const { sent, textarea } = await openKittyPane()

  dispatchUnidentifiedCtrlSpace(textarea, 'keydown')
  dispatchUnidentifiedCtrlSpace(textarea, 'keyup', true)

  expect(sent).toEqual(['\x1b[32;5u', '\x1b[32;5:3u'])
})

it('leaves Unidentified Ctrl+Space to the legacy 0x00 encoding without Kitty flags', async () => {
  const { sent, textarea } = await openKittyPane('')

  dispatchUnidentifiedCtrlSpace(textarea, 'keydown')
  dispatchUnidentifiedCtrlSpace(textarea, 'keyup')

  expect(sent).toEqual(['\x00'])
})

it('leaves a plain Space to xterm', async () => {
  const { sent, textarea } = await openKittyPane()

  textarea.dispatchEvent(
    new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true, cancelable: true })
  )

  expect(sent).toEqual([' '])
})
