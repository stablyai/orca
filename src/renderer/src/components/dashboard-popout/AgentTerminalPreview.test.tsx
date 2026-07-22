// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  TERMINAL_PASTE_CHUNK_MAX_BYTES,
  TERMINAL_PASTE_DIRECT_MAX_BYTES
} from '@/components/terminal-pane/terminal-paste-limits'
import {
  BRACKETED_PASTE_END,
  BRACKETED_PASTE_START
} from '@/components/terminal-pane/terminal-bracketed-paste'

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
    modes: { bracketedPasteMode: boolean }
    selectionText: string
    customKeyHandler: ((event: KeyboardEvent) => boolean) | null
  }[],
  userInputListener: null as (() => void) | null,
  userInputDispose: vi.fn()
}))

const platformState = vi.hoisted(() => ({ value: 'linux' }))

const imeHarness = vi.hoisted(() => ({
  forwarders: [] as {
    claimKeyEvent: ReturnType<typeof vi.fn>
    dispose: ReturnType<typeof vi.fn>
    sendInput: (data: string) => void
  }[],
  trackers: [] as { dispose: ReturnType<typeof vi.fn> }[],
  claimResult: false,
  inputSourceTrackerRequests: 0
}))

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    rows = 24
    buffer = { active: { cursorY: 0 } }
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
    modes = { bracketedPasteMode: false }
    paste = vi.fn((data: string) => {
      terminalHarness.userInputListener?.()
      this.onDataListener?.(data)
    })
    input = vi.fn((data: string) => {
      terminalHarness.userInputListener?.()
      this.onDataListener?.(data)
    })
    element = document.createElement('div')
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
vi.mock('@/lib/pane-manager/pane-terminal-options', () => ({
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
  installTerminalImeNativeTextForwarder: (args: { sendInput: (data: string) => void }) => {
    const forwarder = {
      claimKeyEvent: vi.fn(() => imeHarness.claimResult),
      dispose: vi.fn(),
      sendInput: args.sendInput
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
vi.mock('@/components/terminal-pane/terminal-ime-input-source', () => ({
  getMacNativeTextInputSourceTracker: () => {
    imeHarness.inputSourceTrackerRequests++
    return { getFeatures: () => ({}) }
  }
}))
vi.mock('@/store', () => {
  const state = { settings: null, keybindings: {} }
  const useAppStore = (selector: (s: typeof state) => unknown): unknown => selector(state)
  useAppStore.getState = (): typeof state => state
  return { useAppStore }
})

import { AgentTerminalPreview } from './AgentTerminalPreview'

describe('AgentTerminalPreview', () => {
  const input = vi.fn(async (_ptyId: string, _data: string) => true)
  const ack = vi.fn(async () => {})
  const unsubscribe = vi.fn(async () => {})
  const connect = vi.fn()
  const readClipboardText = vi.fn(async () => 'clip-text')
  const writeClipboardText = vi.fn(async () => {})
  let emitData: ((payload: unknown) => void) | null
  let emitAppMenuPaste: (() => void) | null

  beforeEach(() => {
    terminalHarness.instances.length = 0
    terminalHarness.userInputListener = null
    platformState.value = 'linux'
    imeHarness.forwarders.length = 0
    imeHarness.trackers.length = 0
    imeHarness.claimResult = false
    imeHarness.inputSourceTrackerRequests = 0
    emitData = null
    emitAppMenuPaste = null
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
          ack,
          unsubscribe,
          onData: (listener: (payload: unknown) => void) => {
            emitData = listener
            return vi.fn()
          }
        },
        ui: {
          readClipboardText,
          writeClipboardText,
          onAppMenuPaste: (listener: () => void) => {
            emitAppMenuPaste = listener
            return vi.fn()
          }
        }
      }
    })
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('routes signaled user input while a live write parses and drops parser replies', async () => {
    render(<AgentTerminalPreview ptyId="pty-1" />)
    await waitFor(() => expect(terminalHarness.instances).toHaveLength(1))
    const terminal = terminalHarness.instances[0]!
    await waitFor(() => expect(terminal.onDataListener).not.toBeNull())

    act(() => {
      emitData?.({ type: 'data', ptyId: 'pty-1', data: '\x1b[6n', bytes: 4 })
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
    expect(ack).toHaveBeenCalledWith('pty-1', 4)
  })

  it('installs the macOS IME native-text forwarder and lets its claims bypass chord handling', async () => {
    platformState.value = 'darwin'
    render(<AgentTerminalPreview ptyId="pty-1" />)
    await waitFor(() => expect(terminalHarness.instances).toHaveLength(1))
    const terminal = terminalHarness.instances[0]!
    await waitFor(() => expect(terminal.customKeyHandler).not.toBeNull())
    expect(imeHarness.forwarders).toHaveLength(1)
    expect(imeHarness.trackers).toHaveLength(1)
    expect(imeHarness.inputSourceTrackerRequests).toBe(1)

    imeHarness.forwarders[0]!.sendInput('。')
    expect(terminal.input).toHaveBeenCalledOnce()
    expect(input).toHaveBeenCalledOnce()
    expect(input).toHaveBeenCalledWith('pty-1', '。')

    // A claimed native-text key bypasses xterm AND the clipboard chords.
    imeHarness.claimResult = true
    terminal.selectionText = 'selected text'
    const handled = terminal.customKeyHandler!(
      new KeyboardEvent('keydown', { key: 'C', code: 'KeyC', metaKey: true, shiftKey: true })
    )
    expect(handled).toBe(false)
    expect(writeClipboardText).not.toHaveBeenCalled()

    // Unclaimed events still reach the chord handling.
    imeHarness.claimResult = false
    const copied = terminal.customKeyHandler!(
      new KeyboardEvent('keydown', { key: 'C', code: 'KeyC', metaKey: true, shiftKey: true })
    )
    expect(copied).toBe(false)
    expect(writeClipboardText).toHaveBeenCalledWith('selected text')
    expect(imeHarness.inputSourceTrackerRequests).toBe(1)
  })

  it('does not install the IME native-text forwarder off macOS', async () => {
    render(<AgentTerminalPreview ptyId="pty-1" />)
    await waitFor(() => expect(terminalHarness.instances).toHaveLength(1))
    await waitFor(() => expect(terminalHarness.instances[0]!.customKeyHandler).not.toBeNull())
    expect(imeHarness.forwarders).toHaveLength(0)
    expect(imeHarness.trackers).toHaveLength(0)
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
    connect.mockResolvedValueOnce({ snapshot: null, replay: [] })
    const view = render(<AgentTerminalPreview ptyId="pty-1" />)
    await waitFor(() => expect(imeHarness.forwarders).toHaveLength(1))

    act(() => emitData?.({ type: 'resync', ptyId: 'pty-1' }))
    await waitFor(() => expect(imeHarness.forwarders[0]!.dispose).toHaveBeenCalledOnce())
    expect(imeHarness.trackers[0]!.dispose).toHaveBeenCalledOnce()

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
    expect(writeClipboardText).toHaveBeenCalledWith('selected text')
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
    expect(writeClipboardText).not.toHaveBeenCalled()
  })

  it('pastes clipboard text on the app-menu paste signal while the preview owns focus', async () => {
    const view = render(<AgentTerminalPreview ptyId="pty-1" />)
    await waitFor(() => expect(terminalHarness.instances).toHaveLength(1))
    const terminal = terminalHarness.instances[0]!
    expect(emitAppMenuPaste).not.toBeNull()

    const host = view.container.querySelector<HTMLElement>('.origin-bottom-left')!
    const focusTarget = document.createElement('input')
    host.appendChild(focusTarget)
    focusTarget.focus()

    act(() => emitAppMenuPaste!())
    await waitFor(() => expect(terminal.paste).toHaveBeenCalledWith('clip-text'))
    expect(input).toHaveBeenCalledWith('pty-1', 'clip-text')
  })

  it('ignores the app-menu paste signal when focus is outside the preview', async () => {
    render(<AgentTerminalPreview ptyId="pty-1" />)
    await waitFor(() => expect(terminalHarness.instances).toHaveLength(1))
    expect(emitAppMenuPaste).not.toBeNull()

    await act(async () => emitAppMenuPaste!())
    expect(readClipboardText).not.toHaveBeenCalled()
    expect(terminalHarness.instances[0]!.paste).not.toHaveBeenCalled()
  })

  it('leaves plain Ctrl+V to the Edit-menu accelerator but handles the shifted paste chord', async () => {
    const view = render(<AgentTerminalPreview ptyId="pty-1" />)
    await waitFor(() => expect(terminalHarness.instances).toHaveLength(1))
    const terminal = terminalHarness.instances[0]!
    await waitFor(() => expect(terminal.customKeyHandler).not.toBeNull())
    const host = view.container.querySelector<HTMLElement>('.origin-bottom-left')!
    const terminalInput = document.createElement('input')
    host.appendChild(terminalInput)
    terminalInput.focus()

    const plain = terminal.customKeyHandler!(
      new KeyboardEvent('keydown', { key: 'v', code: 'KeyV', ctrlKey: true })
    )
    expect(plain).toBe(true)
    expect(readClipboardText).not.toHaveBeenCalled()

    const shiftedEvent = new KeyboardEvent('keydown', {
      key: 'V',
      code: 'KeyV',
      ctrlKey: true,
      shiftKey: true,
      cancelable: true
    })
    const shifted = terminal.customKeyHandler!(shiftedEvent)
    const repeated = terminal.customKeyHandler!(
      new KeyboardEvent('keydown', {
        key: 'V',
        code: 'KeyV',
        ctrlKey: true,
        shiftKey: true,
        repeat: true
      })
    )
    expect(shifted).toBe(false)
    expect(repeated).toBe(false)
    expect(shiftedEvent.defaultPrevented).toBe(true)
    await waitFor(() => expect(terminal.paste).toHaveBeenCalledWith('clip-text'))
    expect(readClipboardText).toHaveBeenCalledTimes(1)
    expect(
      terminal.customKeyHandler!(
        new KeyboardEvent('keyup', { key: 'V', code: 'KeyV', ctrlKey: true, shiftKey: true })
      )
    ).toBe(false)
  })

  it('cancels an async paste when the preview loses focus', async () => {
    let resolveClipboard!: (text: string) => void
    readClipboardText.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveClipboard = resolve
      })
    )
    const view = render(<AgentTerminalPreview ptyId="pty-1" />)
    await waitFor(() => expect(terminalHarness.instances).toHaveLength(1))
    const terminal = terminalHarness.instances[0]!
    const host = view.container.querySelector<HTMLElement>('.origin-bottom-left')!
    const terminalInput = document.createElement('input')
    const outsideInput = document.createElement('input')
    host.appendChild(terminalInput)
    view.container.appendChild(outsideInput)
    terminalInput.focus()

    act(() => emitAppMenuPaste!())
    outsideInput.focus()
    await act(async () => resolveClipboard('stale text'))

    expect(terminal.paste).not.toHaveBeenCalled()
    expect(input).not.toHaveBeenCalled()
  })

  it('streams large pastes as bounded IPC payloads instead of one renderer-blocking write', async () => {
    const encoder = new TextEncoder()
    const multibytePrefix = '😀'.repeat(TERMINAL_PASTE_DIRECT_MAX_BYTES / 4 + 1)
    const largePaste = `${multibytePrefix}\r\nnext\n`
    const expectedPaste = `${multibytePrefix}\rnext\r`
    readClipboardText.mockResolvedValueOnce(largePaste)
    const view = render(<AgentTerminalPreview ptyId="pty-1" />)
    await waitFor(() => expect(terminalHarness.instances).toHaveLength(1))
    const terminal = terminalHarness.instances[0]!
    const host = view.container.querySelector<HTMLElement>('.origin-bottom-left')!
    const terminalInput = document.createElement('input')
    host.appendChild(terminalInput)
    terminalInput.focus()

    act(() => emitAppMenuPaste!())
    const expectedChunks = Math.ceil(
      encoder.encode(expectedPaste).byteLength / TERMINAL_PASTE_CHUNK_MAX_BYTES
    )
    await waitFor(() => expect(input).toHaveBeenCalledTimes(expectedChunks))

    const payloads = input.mock.calls.map(([, data]) => data as string)
    expect(terminal.paste).not.toHaveBeenCalled()
    expect(payloads.join('')).toBe(expectedPaste)
    expect(
      payloads.every(
        (payload) => encoder.encode(payload).byteLength <= TERMINAL_PASTE_CHUNK_MAX_BYTES
      )
    ).toBe(true)
  })

  it('closes a bracketed large paste when focus changes between chunks', async () => {
    readClipboardText.mockResolvedValueOnce('x'.repeat(TERMINAL_PASTE_DIRECT_MAX_BYTES + 1))
    const view = render(<AgentTerminalPreview ptyId="pty-1" />)
    await waitFor(() => expect(terminalHarness.instances).toHaveLength(1))
    const terminal = terminalHarness.instances[0]!
    terminal.modes.bracketedPasteMode = true
    const host = view.container.querySelector<HTMLElement>('.origin-bottom-left')!
    const terminalInput = document.createElement('input')
    const outsideInput = document.createElement('input')
    host.appendChild(terminalInput)
    view.container.appendChild(outsideInput)
    terminalInput.focus()
    input.mockImplementationOnce(async () => {
      outsideInput.focus()
      return true
    })

    act(() => emitAppMenuPaste!())
    await waitFor(() => expect(input).toHaveBeenCalledTimes(2))

    expect(input.mock.calls.map(([, data]) => data)).toEqual([
      BRACKETED_PASTE_START,
      BRACKETED_PASTE_END
    ])
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

    act(() => emitData?.({ type: 'resync', ptyId: 'pty-1' }))
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
      .mockResolvedValueOnce({ snapshot: null, replay: [] })
    const view = render(<AgentTerminalPreview ptyId="pty-1" />)
    await waitFor(() => expect(terminalHarness.instances).toHaveLength(1))
    const terminal = terminalHarness.instances[0]!

    act(() => emitData?.({ type: 'resync', ptyId: 'pty-1' }))

    await waitFor(() => expect(view.getByText(/No live terminal/)).toBeInTheDocument())
    expect(terminal.dispose).toHaveBeenCalledTimes(1)
    expect(terminalHarness.userInputDispose).toHaveBeenCalledTimes(1)
    expect(unsubscribe).toHaveBeenCalledWith('pty-1')
  })

  it('connects a replacement pty after the previous pty was gone', async () => {
    connect.mockResolvedValueOnce({ snapshot: null, replay: [] }).mockResolvedValueOnce({
      snapshot: { data: 'replacement', cols: 80, rows: 24, seq: 1 },
      replay: []
    })
    const view = render(<AgentTerminalPreview ptyId="pty-gone" />)
    await waitFor(() => expect(view.getByText(/No live terminal/)).toBeInTheDocument())

    view.rerender(<AgentTerminalPreview ptyId="pty-live" />)

    await waitFor(() => expect(terminalHarness.instances).toHaveLength(1))
    expect(connect).toHaveBeenLastCalledWith('pty-live', { scrollbackRows: 24 })
    expect(view.queryByText(/No live terminal/)).not.toBeInTheDocument()
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
