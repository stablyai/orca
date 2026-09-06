// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const terminalHarness = vi.hoisted(() => ({
  instances: [] as {
    write: ReturnType<typeof vi.fn>
    writeCallbacks: (() => void)[]
    onDataListener: ((data: string) => void) | null
    dispose: ReturnType<typeof vi.fn>
    resize: ReturnType<typeof vi.fn>
    reset: ReturnType<typeof vi.fn>
    paste: ReturnType<typeof vi.fn>
    input: ReturnType<typeof vi.fn>
    scrollToTop: ReturnType<typeof vi.fn>
    scrollToBottom: ReturnType<typeof vi.fn>
    selectAll: ReturnType<typeof vi.fn>
    modes: { bracketedPasteMode: boolean; mouseTrackingMode: string }
    buffer: { active: { cursorY: number; viewportY: number; baseY: number } }
    selectionText: string
    customKeyHandler: ((event: KeyboardEvent) => boolean) | null
  }[],
  userInputListener: null as (() => void) | null,
  userInputDispose: vi.fn()
}))

const platformState = vi.hoisted(() => ({ value: 'linux' }))
const storeState = vi.hoisted(() => ({
  settings: null,
  keybindings: {} as Record<string, string[]>
}))

const imeHarness = vi.hoisted(() => ({
  forwarders: [] as {
    claimKeyEvent: ReturnType<typeof vi.fn>
    dispose: ReturnType<typeof vi.fn>
    sendInput: (data: string) => void
    getKittyKeyboardFlags: () => number
  }[],
  trackers: [] as { dispose: ReturnType<typeof vi.fn> }[],
  claimResult: false
}))

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80
    rows = 24
    buffer = { active: { cursorY: 0, viewportY: 0, baseY: 0 } }
    writeCallbacks: (() => void)[] = []
    onDataListener: ((data: string) => void) | null = null
    customKeyHandler: ((event: KeyboardEvent) => boolean) | null = null
    selectionText = ''
    write = vi.fn((_data: string, callback?: () => void) => {
      if (callback) {
        this.writeCallbacks.push(callback)
      }
    })
    open = vi.fn()
    focus = vi.fn()
    dispose = vi.fn()
    resize = vi.fn()
    reset = vi.fn()
    modes = { bracketedPasteMode: false, mouseTrackingMode: 'none' }
    paste = vi.fn((data: string) => {
      terminalHarness.userInputListener?.()
      this.onDataListener?.(data)
    })
    input = vi.fn((data: string) => {
      terminalHarness.userInputListener?.()
      this.onDataListener?.(data)
    })
    element = document.createElement('div')
    unicode = { activeVersion: '6', versions: ['6', '11'], register: vi.fn() }
    loadAddon = vi.fn()
    attachCustomWheelEventHandler = vi.fn()
    scrollToTop = vi.fn()
    scrollToBottom = vi.fn()
    selectAll = vi.fn()
    getSelection = vi.fn(() => this.selectionText)
    attachCustomKeyEventHandler = vi.fn((handler: (event: KeyboardEvent) => boolean) => {
      this.customKeyHandler = handler
    })
    onData = vi.fn((listener: (data: string) => void) => {
      this.onDataListener = listener
      return { dispose: vi.fn() }
    })

    constructor() {
      terminalHarness.instances.push(this)
    }
  }
}))
vi.mock(import('@/lib/pane-manager/pane-terminal-options'), async (importOriginal) => ({
  ...(await importOriginal()),
  buildDefaultTerminalOptions: () => ({})
}))
vi.mock('@/components/terminal-pane/terminal-user-input-signal', () => ({
  subscribeToTerminalUserInput: (_terminal: unknown, listener: () => void) => {
    terminalHarness.userInputListener = listener
    return { dispose: terminalHarness.userInputDispose }
  }
}))
vi.mock('@/components/terminal-pane/use-system-prefers-dark', () => ({
  useSystemPrefersDark: () => false
}))
vi.mock('@/lib/shortcut-platform', () => ({
  getShortcutPlatform: () => platformState.value
}))
vi.mock('@/components/terminal-pane/terminal-ime-native-text-forwarder', () => ({
  installTerminalImeNativeTextForwarder: (args: {
    sendInput: (data: string) => void
    getKittyKeyboardFlags?: () => number
  }) => {
    const forwarder = {
      claimKeyEvent: vi.fn(() => imeHarness.claimResult),
      dispose: vi.fn(),
      sendInput: args.sendInput,
      // Why captured: the bridge's whole job is handing the live mirror to the
      // forwarder, so the test reads what a real commit would read.
      getKittyKeyboardFlags: args.getKittyKeyboardFlags ?? ((): number => 0)
    }
    imeHarness.forwarders.push(forwarder)
    return forwarder
  }
}))
vi.mock('@/components/terminal-pane/terminal-ime-composition-tracker', () => ({
  installTerminalImeCompositionTracker: () => {
    const tracker = { isActive: () => false, dispose: vi.fn() }
    imeHarness.trackers.push(tracker)
    return tracker
  }
}))
vi.mock('@/store', () => {
  const useAppStore = (selector: (s: typeof storeState) => unknown): unknown => selector(storeState)
  useAppStore.getState = (): typeof storeState => storeState
  return { useAppStore }
})

import { AgentTerminalPreview } from './AgentTerminalPreview'

describe('AgentTerminalPreview', () => {
  const input = vi.fn(async (_ptyId: string, _data: string) => true)
  const fit = vi.fn(async (_ptyId: string, cols: number, rows: number, _surfaceId?: string) => ({
    cols,
    rows
  }))
  const ack = vi.fn(async () => {})
  const unsubscribe = vi.fn(async () => {})
  const connect = vi.fn()
  const readClipboardText = vi.fn(async () => 'clip-text')
  const writeClipboardText = vi.fn(async () => {})
  const writeTerminalClipboardText = vi.fn(async () => {})
  const dataListeners: ((payload: unknown) => void)[] = []
  // Fans out like the real IPC channel: every mounted preview hears every payload.
  const emitData = (payload: unknown): void => dataListeners.forEach((l) => l(payload))

  beforeEach(() => {
    terminalHarness.instances.length = 0
    terminalHarness.userInputListener = null
    platformState.value = 'linux'
    storeState.keybindings = {}
    imeHarness.forwarders.length = 0
    imeHarness.trackers.length = 0
    imeHarness.claimResult = false
    dataListeners.length = 0
    connect.mockResolvedValue({
      snapshot: { data: '', cols: 80, rows: 24, seq: 1 },
      replay: []
    })
    readClipboardText.mockResolvedValue('clip-text')
    Object.assign(window, {
      api: {
        terminalPreview: {
          connect,
          input,
          fit,
          ack,
          unsubscribe,
          onData: (listener: (payload: unknown) => void) => {
            dataListeners.push(listener)
            return () => dataListeners.splice(dataListeners.indexOf(listener), 1)
          }
        },
        ui: {
          readClipboardText,
          writeClipboardText,
          writeTerminalClipboardText,
          performNativeSelectionAction: vi.fn()
        }
      }
    })
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('routes signaled user input while a live write parses and drops parser replies', async () => {
    render(<AgentTerminalPreview ptyId="pty-1" />)
    await waitFor(() => expect(terminalHarness.instances).toHaveLength(1))
    const terminal = terminalHarness.instances[0]!
    await waitFor(() => expect(terminal.onDataListener).not.toBeNull())

    act(() => {
      emitData({ type: 'data', ptyId: 'pty-1', data: '\x1b[6n', bytes: 4 })
    })
    expect(terminal.write).toHaveBeenCalledWith('\x1b[6n', expect.any(Function))

    act(() => {
      terminalHarness.userInputListener?.()
      terminal.onDataListener?.('k')
      terminal.onDataListener?.('\x1b[1;1R')
    })
    expect(input).toHaveBeenCalledTimes(1)
    expect(input).toHaveBeenCalledWith('pty-1', 'k')

    act(() => terminal.writeCallbacks.shift()?.())
    expect(ack).toHaveBeenCalledWith('pty-1', 4, expect.any(String))
  })

  it('installs the macOS IME native-text forwarder and lets its claims bypass chord handling', async () => {
    platformState.value = 'darwin'
    render(<AgentTerminalPreview ptyId="pty-1" />)
    await waitFor(() => expect(terminalHarness.instances).toHaveLength(1))
    const terminal = terminalHarness.instances[0]!
    await waitFor(() => expect(terminal.customKeyHandler).not.toBeNull())
    expect(imeHarness.forwarders).toHaveLength(1)
    expect(imeHarness.trackers).toHaveLength(1)

    imeHarness.forwarders[0]!.sendInput('。')
    expect(terminal.input).toHaveBeenCalledOnce()
    expect(input).toHaveBeenCalledOnce()
    expect(input).toHaveBeenCalledWith('pty-1', '。')

    // A claimed native-text key bypasses xterm AND the clipboard chords.
    imeHarness.claimResult = true
    terminal.selectionText = 'selected text'
    const handled = terminal.customKeyHandler!(
      new KeyboardEvent('keydown', { key: 'C', code: 'KeyC', ctrlKey: true, shiftKey: true })
    )
    expect(handled).toBe(false)
    expect(writeClipboardText).not.toHaveBeenCalled()
    expect(writeTerminalClipboardText).not.toHaveBeenCalled()

    // Unclaimed events still reach the chord handling.
    imeHarness.claimResult = false
    const copied = terminal.customKeyHandler!(
      new KeyboardEvent('keydown', { key: 'c', code: 'KeyC', metaKey: true })
    )
    expect(copied).toBe(false)
    expect(writeTerminalClipboardText).toHaveBeenCalledWith('selected text')
    expect(writeClipboardText).not.toHaveBeenCalled()
  })

  it('does not install the IME native-text forwarder off macOS', async () => {
    render(<AgentTerminalPreview ptyId="pty-1" />)
    await waitFor(() => expect(terminalHarness.instances).toHaveLength(1))
    await waitFor(() => expect(terminalHarness.instances[0]!.customKeyHandler).not.toBeNull())
    expect(imeHarness.forwarders).toHaveLength(0)
    expect(imeHarness.trackers).toHaveLength(0)
  })

  // The bridge omitted this dependency entirely, so every Preview
  // commit was evaluated at flags 0. Ordering and provenance live in
  // preview-terminal-snapshot-replay.test.ts; this pins the wiring.
  it('hands the forwarder the live mirror seeded from the snapshot flags', async () => {
    platformState.value = 'darwin'
    connect.mockResolvedValue({
      snapshot: { data: '', cols: 80, rows: 24, seq: 1, kittyKeyboardFlags: 8 },
      replay: []
    })
    render(<AgentTerminalPreview ptyId="pty-1" />)
    await waitFor(() => expect(imeHarness.forwarders).toHaveLength(1))
    await waitFor(() => expect(imeHarness.forwarders[0]!.getKittyKeyboardFlags()).toBe(8))

    // Live output keeps advancing the same mirror the forwarder reads.
    act(() => {
      emitData({ type: 'data', ptyId: 'pty-1', data: '\x1b[<u', bytes: 4 })
    })
    expect(imeHarness.forwarders[0]!.getKittyKeyboardFlags()).toBe(0)
  })

  it('disposes the IME bridge on unmount', async () => {
    platformState.value = 'darwin'
    const view = render(<AgentTerminalPreview ptyId="pty-1" />)
    await waitFor(() => expect(imeHarness.forwarders).toHaveLength(1))
    view.unmount()
    expect(imeHarness.forwarders[0]!.dispose).toHaveBeenCalledTimes(1)
    expect(imeHarness.trackers[0]!.dispose).toHaveBeenCalledTimes(1)
  })

  it('disposes the IME bridge once when the PTY disappears', async () => {
    platformState.value = 'darwin'
    connect.mockResolvedValueOnce({
      snapshot: { data: '', cols: 80, rows: 24, seq: 1 },
      replay: []
    })
    connect.mockResolvedValueOnce({ snapshot: null, replay: [], liveness: 'exited' })
    const onPtyGone = vi.fn()
    const view = render(<AgentTerminalPreview ptyId="pty-1" onPtyGone={onPtyGone} />)
    await waitFor(() => expect(imeHarness.forwarders).toHaveLength(1))

    act(() => emitData({ type: 'resync', ptyId: 'pty-1' }))
    await waitFor(() => expect(imeHarness.forwarders[0]!.dispose).toHaveBeenCalledOnce())
    expect(imeHarness.trackers[0]!.dispose).toHaveBeenCalledOnce()
    expect(onPtyGone).toHaveBeenCalledOnce()

    view.unmount()
    expect(imeHarness.forwarders[0]!.dispose).toHaveBeenCalledOnce()
    expect(imeHarness.trackers[0]!.dispose).toHaveBeenCalledOnce()
  })

  it('copies the terminal selection on the copy chord and blocks xterm handling', async () => {
    render(<AgentTerminalPreview ptyId="pty-1" />)
    await waitFor(() => expect(terminalHarness.instances).toHaveLength(1))
    const terminal = terminalHarness.instances[0]!
    await waitFor(() => expect(terminal.customKeyHandler).not.toBeNull())

    terminal.selectionText = 'selected text'
    const keydown = new KeyboardEvent('keydown', {
      key: 'C',
      code: 'KeyC',
      ctrlKey: true,
      shiftKey: true,
      cancelable: true
    })
    const handled = terminal.customKeyHandler!(keydown)
    const keyupHandled = terminal.customKeyHandler!(
      new KeyboardEvent('keyup', { key: 'C', code: 'KeyC', ctrlKey: true, shiftKey: true })
    )
    expect(handled).toBe(false)
    expect(keyupHandled).toBe(false)
    expect(keydown.defaultPrevented).toBe(true)
    expect(writeTerminalClipboardText).toHaveBeenCalledWith('selected text')
    expect(writeClipboardText).not.toHaveBeenCalled()
  })

  it('keeps an empty copy chord from leaking terminal input', async () => {
    render(<AgentTerminalPreview ptyId="pty-1" />)
    await waitFor(() => expect(terminalHarness.instances).toHaveLength(1))
    const terminal = terminalHarness.instances[0]!
    await waitFor(() => expect(terminal.customKeyHandler).not.toBeNull())

    const handled = terminal.customKeyHandler!(
      new KeyboardEvent('keydown', { key: 'C', code: 'KeyC', ctrlKey: true, shiftKey: true })
    )
    expect(handled).toBe(false)
    expect(writeTerminalClipboardText).not.toHaveBeenCalled()
  })

  it('leaves bare Ctrl+C available to the terminal without a selection', async () => {
    render(<AgentTerminalPreview ptyId="pty-1" />)
    await waitFor(() => expect(terminalHarness.instances).toHaveLength(1))
    const terminal = terminalHarness.instances[0]!
    await waitFor(() => expect(terminal.customKeyHandler).not.toBeNull())

    const handled = terminal.customKeyHandler!(
      new KeyboardEvent('keydown', { key: 'c', code: 'KeyC', ctrlKey: true })
    )
    expect(handled).toBe(true)
    expect(writeTerminalClipboardText).not.toHaveBeenCalled()
  })

  it('selects all terminal text on Cmd+A and blocks xterm handling', async () => {
    platformState.value = 'darwin'
    render(<AgentTerminalPreview ptyId="pty-1" />)
    await waitFor(() => expect(terminalHarness.instances).toHaveLength(1))
    const terminal = terminalHarness.instances[0]!
    await waitFor(() => expect(terminal.customKeyHandler).not.toBeNull())

    const keydown = new KeyboardEvent('keydown', {
      key: 'a',
      code: 'KeyA',
      metaKey: true,
      cancelable: true
    })
    expect(terminal.customKeyHandler!(keydown)).toBe(false)
    expect(keydown.defaultPrevented).toBe(true)

    const repeat = new KeyboardEvent('keydown', {
      key: 'a',
      code: 'KeyA',
      metaKey: true,
      repeat: true,
      cancelable: true
    })
    expect(terminal.customKeyHandler!(repeat)).toBe(false)
    expect(repeat.defaultPrevented).toBe(true)
    expect(terminal.selectAll).toHaveBeenCalledOnce()
  })

  it('sends the word-kill byte on Ctrl+Backspace and blocks xterm handling', async () => {
    render(<AgentTerminalPreview ptyId="pty-1" />)
    await waitFor(() => expect(terminalHarness.instances).toHaveLength(1))
    const terminal = terminalHarness.instances[0]!
    await waitFor(() => expect(terminal.customKeyHandler).not.toBeNull())

    const keydown = new KeyboardEvent('keydown', {
      key: 'Backspace',
      code: 'Backspace',
      ctrlKey: true,
      cancelable: true
    })
    const handled = terminal.customKeyHandler!(keydown)

    expect(handled).toBe(false)
    expect(keydown.defaultPrevented).toBe(true)
    expect(terminal.input).toHaveBeenCalledWith('\x17')
    await waitFor(() => expect(input).toHaveBeenCalledWith('pty-1', '\x17'))
  })

  it('swallows a pane-scoped chord instead of leaking its control byte to the agent', async () => {
    render(<AgentTerminalPreview ptyId="pty-1" />)
    await waitFor(() => expect(terminalHarness.instances).toHaveLength(1))
    const terminal = terminalHarness.instances[0]!
    await waitFor(() => expect(terminal.customKeyHandler).not.toBeNull())

    // Ctrl+Shift+D splits a pane on Linux; xterm would otherwise send Ctrl+D.
    const keydown = new KeyboardEvent('keydown', {
      key: 'D',
      code: 'KeyD',
      ctrlKey: true,
      shiftKey: true,
      cancelable: true
    })
    const handled = terminal.customKeyHandler!(keydown)

    expect(handled).toBe(false)
    expect(keydown.defaultPrevented).toBe(true)
    expect(terminal.input).not.toHaveBeenCalled()
    expect(input).not.toHaveBeenCalled()
  })

  it('keeps a native input-source chord from inserting text into the preview', async () => {
    storeState.keybindings = { 'terminal.switchInputSource': ['Shift+Space'] }
    const view = render(<AgentTerminalPreview ptyId="pty-1" />)
    await waitFor(() => expect(terminalHarness.instances).toHaveLength(1))
    const terminal = terminalHarness.instances[0]!
    await waitFor(() => expect(terminal.customKeyHandler).not.toBeNull())

    const keydown = new KeyboardEvent('keydown', {
      key: ' ',
      code: 'Space',
      shiftKey: true,
      bubbles: true,
      cancelable: true
    })
    expect(terminal.customKeyHandler!(keydown)).toBe(false)
    expect(keydown.defaultPrevented).toBe(false)

    const keypress = new KeyboardEvent('keypress', {
      key: ' ',
      bubbles: true,
      cancelable: true
    })
    window.dispatchEvent(keypress)
    expect(keypress.defaultPrevented).toBe(true)

    const beforeInput = new InputEvent('beforeinput', {
      data: ' ',
      inputType: 'insertText',
      bubbles: true,
      cancelable: true
    })
    window.dispatchEvent(beforeInput)
    expect(beforeInput.defaultPrevented).toBe(true)

    window.dispatchEvent(new KeyboardEvent('keyup', { key: ' ', code: 'Space', bubbles: true }))
    const unarmedBeforeInput = new InputEvent('beforeinput', {
      data: ' ',
      inputType: 'insertText',
      bubbles: true,
      cancelable: true
    })
    window.dispatchEvent(unarmedBeforeInput)
    expect(unarmedBeforeInput.defaultPrevented).toBe(false)
    expect(terminal.input).not.toHaveBeenCalled()
    expect(input).not.toHaveBeenCalled()

    view.unmount()
  })

  it('defers Option chords to xterm once the TUI negotiates kitty keyboard mode', async () => {
    render(<AgentTerminalPreview ptyId="pty-1" />)
    await waitFor(() => expect(terminalHarness.instances).toHaveLength(1))
    const terminal = terminalHarness.instances[0]!
    await waitFor(() => expect(terminal.customKeyHandler).not.toBeNull())

    const altBackspace = (): KeyboardEvent =>
      new KeyboardEvent('keydown', { key: 'Backspace', code: 'Backspace', altKey: true })
    expect(terminal.customKeyHandler!(altBackspace())).toBe(false)
    expect(terminal.input).toHaveBeenCalledWith('\x1b\x7f')

    // The agent's TUI pushes kitty flags (CSI > 1 u) on the live stream.
    act(() => {
      emitData({ type: 'data', ptyId: 'pty-1', data: '\x1b[>1u', bytes: 5 })
    })
    terminal.input.mockClear()

    expect(terminal.customKeyHandler!(altBackspace())).toBe(true)
    expect(terminal.input).not.toHaveBeenCalled()
  })

  // Why: a snapshot carries the TUI's one-time kitty push and the post-snapshot
  // replay redelivers it. Applying replays with stack semantics would leave the
  // TUI's single pop on a stale frame, so a plain shell keeps getting
  // kitty-encoded Option chords.
  it('does not let a redelivered kitty push outlive the TUI pop', async () => {
    connect.mockResolvedValueOnce({
      snapshot: { data: '\x1b[>1u', cols: 80, rows: 24, seq: 1 },
      replay: ['\x1b[>1u']
    })
    render(<AgentTerminalPreview ptyId="pty-1" />)
    await waitFor(() => expect(terminalHarness.instances).toHaveLength(1))
    const terminal = terminalHarness.instances[0]!
    await waitFor(() => expect(terminal.customKeyHandler).not.toBeNull())

    const altBackspace = (): KeyboardEvent =>
      new KeyboardEvent('keydown', { key: 'Backspace', code: 'Backspace', altKey: true })
    expect(terminal.customKeyHandler!(altBackspace())).toBe(true)

    // The TUI exits and pops once on the live stream.
    act(() => {
      emitData({ type: 'data', ptyId: 'pty-1', data: '\x1b[<u', bytes: 4 })
    })

    expect(terminal.customKeyHandler!(altBackspace())).toBe(false)
    expect(terminal.input).toHaveBeenCalledWith('\x1b\x7f')
  })

  it('scrolls the viewport on the macOS scrollback chord', async () => {
    platformState.value = 'darwin'
    render(<AgentTerminalPreview ptyId="pty-1" />)
    await waitFor(() => expect(terminalHarness.instances).toHaveLength(1))
    const terminal = terminalHarness.instances[0]!
    await waitFor(() => expect(terminal.customKeyHandler).not.toBeNull())

    const handled = terminal.customKeyHandler!(
      new KeyboardEvent('keydown', { key: 'ArrowUp', code: 'ArrowUp', metaKey: true })
    )

    expect(handled).toBe(false)
    expect(terminal.scrollToTop).toHaveBeenCalled()
    expect(terminal.input).not.toHaveBeenCalled()
  })

  it('leaves an unmodified Backspace to xterm', async () => {
    render(<AgentTerminalPreview ptyId="pty-1" />)
    await waitFor(() => expect(terminalHarness.instances).toHaveLength(1))
    const terminal = terminalHarness.instances[0]!
    await waitFor(() => expect(terminal.customKeyHandler).not.toBeNull())

    const handled = terminal.customKeyHandler!(
      new KeyboardEvent('keydown', { key: 'Backspace', code: 'Backspace', cancelable: true })
    )

    expect(handled).toBe(true)
    expect(terminal.input).not.toHaveBeenCalled()
  })

  it('keeps the existing terminal visible while a resync snapshot is captured', async () => {
    let resolveRefresh!: (value: {
      snapshot: { data: string; cols: number; rows: number; seq: number }
      replay: string[]
    }) => void
    connect
      .mockResolvedValueOnce({
        snapshot: { data: 'first', cols: 80, rows: 24, seq: 1 },
        replay: []
      })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveRefresh = resolve
          })
      )
    const view = render(<AgentTerminalPreview ptyId="pty-1" />)
    await waitFor(() => expect(terminalHarness.instances).toHaveLength(1))
    const terminal = terminalHarness.instances[0]!

    act(() => emitData({ type: 'resync', ptyId: 'pty-1' }))
    await waitFor(() => expect(connect).toHaveBeenCalledTimes(2))
    expect(terminalHarness.instances).toHaveLength(1)
    expect(terminal.dispose).not.toHaveBeenCalled()
    expect(terminal.reset).not.toHaveBeenCalled()
    expect(view.queryByText(/No live terminal/)).not.toBeInTheDocument()

    await act(async () => {
      resolveRefresh({
        snapshot: { data: 'second', cols: 100, rows: 30, seq: 2 },
        replay: []
      })
    })
    await waitFor(() => expect(terminal.reset).toHaveBeenCalledTimes(1))
    expect(terminal.resize).toHaveBeenCalledWith(100, 30)
    expect(terminalHarness.instances).toHaveLength(1)
    expect(terminal.dispose).not.toHaveBeenCalled()
    expect(view.queryByText(/No live terminal/)).not.toBeInTheDocument()
  })

  it('disposes a stale terminal when resync confirms the pty is gone', async () => {
    connect
      .mockResolvedValueOnce({
        snapshot: { data: 'first', cols: 80, rows: 24, seq: 1 },
        replay: []
      })
      .mockResolvedValueOnce({ snapshot: null, replay: [], liveness: 'exited' })
    const view = render(<AgentTerminalPreview ptyId="pty-1" />)
    await waitFor(() => expect(terminalHarness.instances).toHaveLength(1))
    const terminal = terminalHarness.instances[0]!

    act(() => emitData({ type: 'resync', ptyId: 'pty-1' }))

    await waitFor(() => expect(view.getByText(/No live terminal/)).toBeInTheDocument())
    expect(terminal.dispose).toHaveBeenCalledTimes(1)
    expect(terminalHarness.userInputDispose).toHaveBeenCalledTimes(1)
    expect(unsubscribe).toHaveBeenCalledWith('pty-1', expect.any(String))
  })

  it('does not claim a remote pane closed when no snapshot can exist for it', async () => {
    connect.mockResolvedValueOnce({ snapshot: null, replay: [] })
    const view = render(<AgentTerminalPreview ptyId="ssh:devbox@@pty-3" />)

    await waitFor(() => expect(view.getByText(/remote session/)).toBeInTheDocument())
    expect(view.queryByText(/pane has closed/)).not.toBeInTheDocument()
  })

  it('connects a replacement pty after the previous pty was gone', async () => {
    vi.useFakeTimers()
    connect.mockImplementation(async (id: string) =>
      id === 'pty-live'
        ? { snapshot: { data: 'replacement', cols: 80, rows: 24, seq: 1 }, replay: [] }
        : { snapshot: null, replay: [], liveness: 'exited' }
    )
    const view = render(<AgentTerminalPreview ptyId="pty-gone" />)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(view.getByText(/No live terminal/)).toBeInTheDocument()

    view.rerender(<AgentTerminalPreview ptyId="pty-live" />)

    await vi.waitFor(() => expect(terminalHarness.instances).toHaveLength(1))
    expect(connect).toHaveBeenLastCalledWith('pty-live', {
      scrollbackRows: 24,
      surfaceId: expect.any(String)
    })
    expect(view.queryByText(/No live terminal/)).not.toBeInTheDocument()
  })

  it('veils the terminal across a resync repaint and lifts it once the replay lands', async () => {
    vi.useFakeTimers()
    vi.stubGlobal(
      'requestAnimationFrame',
      (cb: FrameRequestCallback) => setTimeout(() => cb(0), 16) as unknown as number
    )
    let resolveRefresh!: (value: {
      snapshot: { data: string; cols: number; rows: number; seq: number }
      replay: never[]
    }) => void
    connect
      .mockResolvedValueOnce({
        snapshot: { data: 'first', cols: 80, rows: 24, seq: 1 },
        replay: []
      })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveRefresh = resolve
          })
      )
    const view = render(<AgentTerminalPreview ptyId="pty-1" />)
    await vi.waitFor(() => expect(terminalHarness.instances).toHaveLength(1))
    const terminal = terminalHarness.instances[0]!
    await act(async () => {
      terminal.writeCallbacks.splice(0).forEach((cb) => cb())
      await vi.advanceTimersByTimeAsync(32)
    })
    expect(view.getByTestId('preview-phase-veil').dataset.visible).toBe('false')

    act(() => emitData({ type: 'resync', ptyId: 'pty-1' }))
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(2))
    await act(async () => {
      resolveRefresh({ snapshot: { data: 'second', cols: 100, rows: 30, seq: 2 }, replay: [] })
    })
    // The veil goes up before the reset, and only after the anti-flicker delay.
    expect(terminal.reset).toHaveBeenCalledTimes(1)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })
    expect(view.getByTestId('preview-phase-veil').dataset.visible).toBe('true')

    await act(async () => {
      terminal.writeCallbacks.splice(0).forEach((cb) => cb())
      await vi.advanceTimersByTimeAsync(32)
    })
    expect(view.getByTestId('preview-phase-veil').dataset.visible).toBe('false')
  })

  it('leaves the wheel to xterm unless a surface opts into overflow handoff', async () => {
    const view = render(<AgentTerminalPreview ptyId="pty-1" />)
    await waitFor(() => expect(terminalHarness.instances).toHaveLength(1))
    const host = view.container.querySelector<HTMLElement>('.origin-bottom-left')!

    const wheel = new WheelEvent('wheel', { deltaY: 40, bubbles: true, cancelable: true })
    host.dispatchEvent(wheel)

    expect(wheel.defaultPrevented).toBe(false)
  })

  it('hands the wheel to the surface only once the terminal cannot scroll that way', async () => {
    const onWheelOverflow = vi.fn((event: WheelEvent) => event.preventDefault())
    const view = render(<AgentTerminalPreview ptyId="pty-1" onWheelOverflow={onWheelOverflow} />)
    await waitFor(() => expect(terminalHarness.instances).toHaveLength(1))
    const terminal = terminalHarness.instances[0]!
    const host = view.container.querySelector<HTMLElement>('.origin-bottom-left')!
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000)

    // Scrollback above the viewport: wheel-up is xterm's.
    terminal.buffer.active.baseY = 10
    terminal.buffer.active.viewportY = 5
    const up = new WheelEvent('wheel', { deltaY: -40, bubbles: true, cancelable: true })
    host.dispatchEvent(up)
    expect(onWheelOverflow).not.toHaveBeenCalled()
    expect(up.defaultPrevented).toBe(false)

    // At the bottom, a fresh gesture later: wheel-down overflows to the surface, which owns preventDefault.
    clock.mockReturnValue(2_000)
    terminal.buffer.active.viewportY = 10
    const down = new WheelEvent('wheel', { deltaY: 40, bubbles: true, cancelable: true })
    host.dispatchEvent(down)
    expect(onWheelOverflow).toHaveBeenCalledWith(down)
    expect(down.defaultPrevented).toBe(true)

    // Shift bypasses the terminal entirely.
    const shifted = new WheelEvent('wheel', { deltaY: 40, bubbles: true })
    // happy-dom's WheelEvent init drops modifier keys.
    Object.defineProperty(shifted, 'shiftKey', { value: true })
    host.dispatchEvent(shifted)
    expect(onWheelOverflow).toHaveBeenCalledTimes(1)
    clock.mockRestore()
  })

  it('holds a gesture that was scrolling the terminal at the end until it pauses', async () => {
    const onWheelOverflow = vi.fn((event: WheelEvent) => event.preventDefault())
    const view = render(<AgentTerminalPreview ptyId="pty-1" onWheelOverflow={onWheelOverflow} />)
    await waitFor(() => expect(terminalHarness.instances).toHaveLength(1))
    const terminal = terminalHarness.instances[0]!
    const host = view.container.querySelector<HTMLElement>('.origin-bottom-left')!
    // Only a wheel the terminal keeps propagates past the host; held and handed-off ones are stopped before xterm.
    const propagated = vi.fn()
    view.container.addEventListener('wheel', propagated)
    const clock = vi.spyOn(Date, 'now')

    clock.mockReturnValue(1_000)
    terminal.buffer.active.baseY = 10
    terminal.buffer.active.viewportY = 5
    host.dispatchEvent(new WheelEvent('wheel', { deltaY: -40, bubbles: true, cancelable: true }))

    // The same gesture reaches the top: swallowed, and xterm never sees it either.
    clock.mockReturnValue(1_100)
    terminal.buffer.active.viewportY = 0
    const held = new WheelEvent('wheel', { deltaY: -40, bubbles: true, cancelable: true })
    host.dispatchEvent(held)
    expect(held.defaultPrevented).toBe(true)
    expect(onWheelOverflow).not.toHaveBeenCalled()

    // Pushing on keeps the hold alive.
    clock.mockReturnValue(1_350)
    host.dispatchEvent(new WheelEvent('wheel', { deltaY: -40, bubbles: true, cancelable: true }))
    expect(onWheelOverflow).not.toHaveBeenCalled()

    // A pause, then a fresh gesture: the surface takes it.
    clock.mockReturnValue(1_700)
    const fresh = new WheelEvent('wheel', { deltaY: -40, bubbles: true, cancelable: true })
    host.dispatchEvent(fresh)
    expect(onWheelOverflow).toHaveBeenCalledWith(fresh)
    expect(propagated).toHaveBeenCalledTimes(1)
    clock.mockRestore()
  })

  it('keeps two surfaces on the same pty in one window on separate streams', async () => {
    connect.mockImplementation(async (_ptyId: string, opts: { surfaceId?: string }) => ({
      snapshot: { data: `for ${opts.surfaceId}`, cols: 80, rows: 24, seq: 1 },
      replay: []
    }))
    render(
      <>
        <AgentTerminalPreview ptyId="pty-1" />
        <AgentTerminalPreview ptyId="pty-1" />
      </>
    )
    await waitFor(() => expect(terminalHarness.instances).toHaveLength(2))
    const [first, second] = terminalHarness.instances as [
      (typeof terminalHarness.instances)[number],
      (typeof terminalHarness.instances)[number]
    ]
    const surfaceIds = connect.mock.calls.map((call) => call[1].surfaceId as string)
    expect(surfaceIds).toHaveLength(2)
    expect(surfaceIds[0]).not.toBe(surfaceIds[1])
    // A grid card and the dialog it opens are distinct surfaces on main.
    await waitFor(() =>
      expect(first.write).toHaveBeenCalledWith(`for ${surfaceIds[0]}`, expect.any(Function))
    )
    await waitFor(() =>
      expect(second.write).toHaveBeenCalledWith(`for ${surfaceIds[1]}`, expect.any(Function))
    )
    first.write.mockClear()
    second.write.mockClear()
    // Drop the replay writes' callbacks so the next shift() is the live write's.
    first.writeCallbacks.length = 0

    act(() => {
      emitData({
        type: 'data',
        ptyId: 'pty-1',
        data: 'only-first',
        bytes: 10,
        surfaceId: surfaceIds[0]
      })
    })
    expect(first.write).toHaveBeenCalledWith('only-first', expect.any(Function))
    expect(second.write).not.toHaveBeenCalled()
    act(() => first.writeCallbacks.shift()?.())
    expect(ack).toHaveBeenCalledWith('pty-1', 10, surfaceIds[0])

    act(() => emitData({ type: 'resync', ptyId: 'pty-1', surfaceId: surfaceIds[1] }))
    await waitFor(() => expect(connect).toHaveBeenCalledTimes(3))
    expect(connect).toHaveBeenLastCalledWith('pty-1', {
      scrollbackRows: 24,
      surfaceId: surfaceIds[1]
    })
  })

  it('delays repeated capture after an overflow and cancels the retry on unmount', async () => {
    vi.useFakeTimers()
    connect.mockResolvedValue({
      snapshot: { data: 'screen', cols: 80, rows: 24, seq: 1 },
      replay: [],
      resyncRequired: true
    })
    const view = render(<AgentTerminalPreview ptyId="pty-1" />)
    await vi.waitFor(() => expect(terminalHarness.instances).toHaveLength(1))
    const terminal = terminalHarness.instances[0]!
    expect(connect).toHaveBeenCalledTimes(1)

    act(() => terminal.writeCallbacks.splice(0).forEach((callback) => callback()))
    await vi.advanceTimersByTimeAsync(149)
    expect(connect).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(connect).toHaveBeenCalledTimes(2)

    act(() => terminal.writeCallbacks.splice(0).forEach((callback) => callback()))
    view.unmount()
    await vi.advanceTimersByTimeAsync(150)
    expect(connect).toHaveBeenCalledTimes(2)
  })
})
