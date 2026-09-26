// @vitest-environment happy-dom
import { Terminal } from '@xterm/xterm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ManagedPane } from '@/lib/pane-manager/pane-manager'
import { TerminalKittyKeyboardModeTracker } from '../../../../shared/terminal-kitty-keyboard-mode-tracker'
import { installTerminalPaneInputHandling } from './terminal-pane-pane-input'

describe('macOS Cmd+C through installed terminal input handling', () => {
  beforeEach(() => {
    vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue('Macintosh')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: xterm only uses measureText from this canvas stub.
    const canvasContext = {
      measureText: () => ({ width: 10 })
    } as unknown as CanvasRenderingContext2D
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(canvasContext)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    document.body.replaceChildren()
  })

  async function open(flags: number, selected = false) {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const terminal = new Terminal({ vtExtensions: { kittyKeyboard: true } })
    terminal.open(container)
    const tracker = new TerminalKittyKeyboardModeTracker()
    if (flags > 0) {
      const sequence = `\x1b[>${flags}u`
      tracker.scan(sequence)
      await new Promise<void>((resolve) => terminal.write(sequence, resolve))
    }
    if (selected) {
      await new Promise<void>((resolve) => terminal.write('copy me', resolve))
      terminal.selectAll()
      expect(terminal.hasSelection()).toBe(true)
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the input installer reads only pane.id and pane.terminal.
    const pane = { id: 1, terminal } as ManagedPane
    const imeCompositionDisposablesRef = { current: new Map() }
    const imeNativeTextForwarderDisposablesRef = { current: new Map() }
    installTerminalPaneInputHandling({
      pane,
      managerRef: { current: null },
      paneKittyKeyboardModesRef: { current: new Map([[pane.id, tracker]]) },
      settingsRef: { current: null },
      imeCompositionDisposablesRef,
      imeNativeTextForwarderDisposablesRef
    })
    const emitted: string[] = []
    terminal.onData((data) => emitted.push(data))
    const key = (type: 'keydown' | 'keyup', init = {}) => {
      const event = new KeyboardEvent(type, {
        key: 'c',
        code: 'KeyC',
        metaKey: true,
        bubbles: true,
        cancelable: true,
        ...init
      })
      terminal.textarea!.dispatchEvent(event)
      return event
    }
    return {
      emitted,
      key,
      close: () => {
        for (const disposable of imeCompositionDisposablesRef.current.values()) {
          disposable.dispose()
        }
        for (const disposable of imeNativeTextForwarderDisposablesRef.current.values()) {
          disposable.dispose()
        }
        terminal.dispose()
      }
    }
  }

  it('sends the real xterm Super+C sequence with negotiated disambiguation', async () => {
    const pane = await open(1)
    try {
      expect(pane.key('keydown').defaultPrevented).toBe(true)
      pane.key('keyup')
      expect(pane.emitted).toEqual(['\x1b[99;9u'])
    } finally {
      pane.close()
    }
  })

  it('reports a Super+C release when event types are negotiated', async () => {
    const pane = await open(3)
    try {
      pane.key('keydown')
      pane.key('keyup')
      expect(pane.emitted).toEqual(['\x1b[99;9u', '\x1b[99;9:3u'])
    } finally {
      pane.close()
    }
  })

  it('leaves native selection copy and legacy Cmd+C to the browser', async () => {
    for (const { flags, selected } of [
      { flags: 1, selected: true },
      { flags: 0, selected: false },
      { flags: 4, selected: false },
      { flags: 16, selected: false }
    ]) {
      const pane = await open(flags, selected)
      try {
        expect(pane.key('keydown').defaultPrevented).toBe(false)
        pane.key('keyup')
        expect(pane.emitted).toEqual([])
      } finally {
        pane.close()
      }
    }
  })
})
