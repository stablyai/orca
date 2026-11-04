// @vitest-environment happy-dom
import { Terminal, type IDisposable } from '@xterm/xterm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TerminalKittyKeyboardModeTracker } from '../../../../shared/terminal-kitty-keyboard-mode-tracker'
import { installTerminalPaneInputHandling } from './terminal-pane-pane-input'

const disposables: IDisposable[] = []
const originalGetContext = Object.getOwnPropertyDescriptor(
  HTMLCanvasElement.prototype,
  'getContext'
)!

async function openPane(platform: string, flags = 0) {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(platform)
  const container = document.createElement('div')
  document.body.appendChild(container)
  const terminal = new Terminal({ cols: 40, rows: 8 })
  disposables.push(terminal)
  terminal.open(container)
  const modes = new TerminalKittyKeyboardModeTracker()
  const modeSequence = `\x1b[=${flags}u`
  modes.scan(modeSequence)
  await new Promise<void>((resolve) => terminal.write(modeSequence, resolve))
  const compositionDisposables = new Map<number, IDisposable>()
  const forwarderDisposables = new Map<number, IDisposable>()
  installTerminalPaneInputHandling({
    pane: { id: 1, terminal },
    managerRef: { current: null },
    paneKittyKeyboardModesRef: { current: new Map([[1, modes]]) },
    settingsRef: { current: {} },
    imeCompositionDisposablesRef: { current: compositionDisposables },
    imeNativeTextForwarderDisposablesRef: { current: forwarderDisposables }
  })
  disposables.push(...compositionDisposables.values(), ...forwarderDisposables.values())
  const input: string[] = []
  disposables.push(terminal.onData((data) => input.push(data)))
  const key = (type: string, init: KeyboardEventInit) => {
    const event = new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init })
    // xterm reads the legacy field, which happy-dom omits from KeyboardEventInit.
    Object.defineProperty(event, 'keyCode', { value: init.keyCode })
    terminal.textarea!.dispatchEvent(event)
    return event
  }
  return { terminal, input, key }
}

beforeEach(() => {
  // happy-dom has no canvas context; xterm uses measureText for its width cache.
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    configurable: true,
    value: () => ({ measureText: () => ({ width: 10 }) })
  })
})

afterEach(() => {
  for (const disposable of disposables.splice(0).toReversed()) {
    disposable.dispose()
  }
  vi.restoreAllMocks()
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', originalGetContext)
  document.body.replaceChildren()
})

describe('native paste precedes non-Latin terminal control input', () => {
  it.each([
    ['Windows NT 10.0', 0],
    ['Windows NT 10.0', 3],
    ['X11; Linux x86_64', 0],
    ['X11; Linux x86_64', 3]
  ])('leaves Russian Ctrl+V to paste on %s with Kitty flags %i', async (platform, flags) => {
    const { terminal, input, key } = await openPane(platform, flags)
    const chord = { key: 'м', code: 'KeyV', keyCode: 86, ctrlKey: true }
    expect(key('keydown', chord).defaultPrevented).toBe(false)
    expect(input).toEqual([])

    const clipboardData = new DataTransfer()
    clipboardData.setData('text/plain', 'clipboard text')
    terminal.textarea!.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true }))
    key('keyup', { ...chord, ctrlKey: false })

    expect(input).toEqual(['clipboard text'])
  })

  it.each([
    ['Macintosh', 'м', 'KeyV', 86, '\x16'],
    ['X11; Linux x86_64', 'ф', 'KeyA', 65, '\x01']
  ])('preserves non-paste Ctrl chords on %s (%s)', async (platform, glyph, code, keyCode, data) => {
    const { input, key } = await openPane(platform, 3)
    const chord = { key: glyph, code, keyCode, ctrlKey: true }
    key('keydown', chord)
    key('keyup', chord)
    expect(input).toEqual([data])
  })
})
