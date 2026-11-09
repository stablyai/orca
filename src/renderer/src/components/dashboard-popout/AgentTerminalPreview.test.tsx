// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import type { ITerminalOptions } from '@xterm/xterm'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalPreviewApi } from '../../../../preload/api/dashboard-api'
import type { TerminalPreviewConnectResult } from '../../../../shared/terminal/replay/terminal-preview'

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
    modes: { bracketedPasteMode: boolean }
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
    unicode = { activeVersion: '6', versions: ['6', '11'], register: vi.fn() }
    loadAddon = vi.fn()
    options: ITerminalOptions = {}
    attachCustomWheelEventHandler = vi.fn()
    scrollToTop = vi.fn()
    scrollToBottom = vi.fn()
    selectAll = vi.fn()
    getSelection = vi.fn(() => this.selectionText)
    hasSelection = vi.fn(() => this.selectionText !== '')
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
vi.mock('@/components/terminal-pane/input/terminal-user-input-signal', () => ({
  subscribeToTerminalUserInput: (_terminal: unknown, listener: () => void) => {
    terminalHarness.userInputListener = listener
    return { dispose: terminalHarness.userInputDispose }
  }
}))
vi.mock('@/hooks/theme/use-system-prefers-dark', () => ({
  useSystemPrefersDark: () => false
}))
vi.mock('@/lib/keyboard/shortcut-platform', () => ({
  getShortcutPlatform: () => platformState.value
}))
vi.mock('@/components/terminal-pane/input/ime/terminal-ime-native-text-forwarder', () => ({
  installTerminalImeNativeTextForwarder: (args: {
    sendInput: (data: string) => void
    getKittyKeyboardFlags?: () => number
  }) => {
    const forwarder = {
      claimKeyEvent: vi.fn(() => imeHarness.claimResult),
      dispose: vi.fn(),
      sendInput: args.sendInput,
      // Read the same live keyboard-mode mirror the real commit forwarder receives.
      getKittyKeyboardFlags: args.getKittyKeyboardFlags ?? ((): number => 0)
    }
    imeHarness.forwarders.push(forwarder)
    return forwarder
  }
}))
vi.mock('@/components/terminal-pane/input/ime/terminal-ime-composition-tracker', () => ({
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

type RemotePreviewSubscription = {
  terminal: string
  callbacks: {
    onSnapshot: (data: string, meta?: { cols?: number; rows?: number; seq?: number }) => void
    onData: (data: string, meta?: { seq?: number }) => void
  }
}
const multiplexerHarness = vi.hoisted(() => {
  const environments: string[] = []
  const subscriptions: RemotePreviewSubscription[] = []
  return { environments, subscriptions, sendInput: vi.fn(() => true), close: vi.fn() }
})
vi.mock(
  '@/runtime/hosted-terminals/streams/registry/remote-runtime-terminal-multiplexer-registry',
  () => ({
    getRemoteRuntimeTerminalMultiplexer: (environmentId: string) => {
      multiplexerHarness.environments.push(environmentId)
      return {
        subscribeTerminal: async (args: RemotePreviewSubscription) => {
          multiplexerHarness.subscriptions.push(args)
          return {
            sendInput: multiplexerHarness.sendInput,
            claimViewport: vi.fn(() => true),
            close: multiplexerHarness.close
          }
        }
      }
    }
  })
)

import { AgentTerminalPreview } from './AgentTerminalPreview'
import { resetRemoteRuntimeTerminalPreviewSessionsForTests } from './remote-runtime-terminal-preview-api'

describe('AgentTerminalPreview', () => {
  const input = vi.fn(async (_ptyId: string, _data: string) => true)
  const fit = vi.fn(async (_ptyId: string, cols: number, rows: number) => ({ cols, rows }))
  const ack = vi.fn(async () => {})
  const unsubscribe = vi.fn(async () => {})
  const connect = vi.fn<TerminalPreviewApi['connect']>()
  const readClipboardText = vi.fn(async () => 'clip-text')
  const writeClipboardText = vi.fn(async () => {})
  const writeTerminalClipboardText = vi.fn(async () => {})
  let emitData: ((payload: unknown) => void) | null

  beforeEach(() => {
    terminalHarness.instances.length = 0
    terminalHarness.userInputListener = null
    platformState.value = 'linux'
    storeState.keybindings = {}
    imeHarness.forwarders.length = 0
    imeHarness.trackers.length = 0
    imeHarness.claimResult = false
    emitData = null
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
            emitData = listener
            return vi.fn()
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
    vi.useRealTimers()
    resetRemoteRuntimeTerminalPreviewSessionsForTests()
    multiplexerHarness.environments.length = 0
    multiplexerHarness.subscriptions.length = 0
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

    // Why drain all: the connection's kitty restore write queues ahead of the live chunk.
    act(() => terminal.writeCallbacks.splice(0).forEach((callback) => callback()))
    expect(ack).toHaveBeenCalledWith('pty-1', 4)
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

  it('lets xterm encode a spatial pane focus chord, since the preview has no panes', async () => {
    render(<AgentTerminalPreview ptyId="pty-1" />)
    await waitFor(() => expect(terminalHarness.instances).toHaveLength(1))
    const terminal = terminalHarness.instances[0]!
    await waitFor(() => expect(terminal.customKeyHandler).not.toBeNull())

    const keydown = new KeyboardEvent('keydown', {
      key: 'ArrowUp',
      code: 'ArrowUp',
      ctrlKey: true,
      altKey: true,
      cancelable: true
    })
    expect(terminal.customKeyHandler!(keydown)).toBe(true)
    expect(keydown.defaultPrevented).toBe(false)
  })

  // Snapshot replay can redeliver a kitty push; it must not leave stale flags after the TUI’s single pop.
  it('does not let a redelivered kitty push outlive the TUI pop', async () => {
    connect.mockResolvedValueOnce({
      snapshot: { data: '\x1b[>1u', cols: 80, rows: 24, seq: 1 },
      replay: [{ data: '\x1b[>1u', mode: 'replay' }]
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
      emitData?.({ type: 'data', ptyId: 'pty-1', data: '\x1b[<u', bytes: 4 })
    })

    expect(terminal.customKeyHandler!(altBackspace())).toBe(false)
    expect(terminal.input).toHaveBeenCalledWith('\x1b\x7f')
  })

  it('keeps the existing terminal visible while a resync snapshot is captured', async () => {
    let resolveRefresh!: (value: TerminalPreviewConnectResult) => void
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
    expect(view.queryByText(/No preview available/)).not.toBeInTheDocument()

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
    expect(view.queryByText(/No preview available/)).not.toBeInTheDocument()
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

    await waitFor(() => expect(view.getByText(/No preview available/)).toBeInTheDocument())
    expect(terminal.dispose).toHaveBeenCalledTimes(1)
    expect(terminalHarness.userInputDispose).toHaveBeenCalledTimes(1)
    expect(unsubscribe).toHaveBeenCalledWith('pty-1')
  })
})
