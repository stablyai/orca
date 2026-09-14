// @vitest-environment happy-dom

import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type PreviewTerminal = {
  customKeyHandler: ((event: KeyboardEvent) => boolean) | null
  input: ReturnType<typeof vi.fn>
}

const terminalHarness = vi.hoisted(() => ({ instances: [] as PreviewTerminal[] }))
const storeState = vi.hoisted(() => ({
  settings: null as { terminalMacOptionAsAlt?: 'true' | 'false' | 'left' | 'right' } | null,
  keybindings: {} as Record<string, string[]>
}))

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80
    rows = 24
    buffer = { active: { cursorY: 0 } }
    customKeyHandler: ((event: KeyboardEvent) => boolean) | null = null
    element = document.createElement('div')
    modes = { bracketedPasteMode: false }
    unicode = { activeVersion: '6', versions: ['6', '11'], register: vi.fn() }
    write = vi.fn((_data: string, callback?: () => void) => callback?.())
    open = vi.fn()
    focus = vi.fn()
    dispose = vi.fn()
    resize = vi.fn()
    reset = vi.fn()
    paste = vi.fn()
    input = vi.fn()
    loadAddon = vi.fn()
    attachCustomWheelEventHandler = vi.fn()
    scrollToTop = vi.fn()
    scrollToBottom = vi.fn()
    selectAll = vi.fn()
    getSelection = vi.fn(() => '')
    attachCustomKeyEventHandler = vi.fn((handler: (event: KeyboardEvent) => boolean) => {
      this.customKeyHandler = handler
    })
    onData = vi.fn(() => ({ dispose: vi.fn() }))

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
  subscribeToTerminalUserInput: () => ({ dispose: vi.fn() })
}))
vi.mock('@/components/terminal-pane/use-system-prefers-dark', () => ({
  useSystemPrefersDark: () => false
}))
vi.mock('@/lib/shortcut-platform', () => ({ getShortcutPlatform: () => 'darwin' }))
vi.mock('@/components/terminal-pane/terminal-ime-native-text-forwarder', () => ({
  installTerminalImeNativeTextForwarder: () => ({
    claimKeyEvent: () => false,
    dispose: vi.fn()
  })
}))
vi.mock('@/components/terminal-pane/terminal-ime-composition-tracker', () => ({
  installTerminalImeCompositionTracker: () => ({ isActive: () => false, dispose: vi.fn() })
}))
vi.mock('@/store', () => {
  const useAppStore = (selector: (state: typeof storeState) => unknown): unknown =>
    selector(storeState)
  useAppStore.getState = (): typeof storeState => storeState
  return { useAppStore }
})

import { AgentTerminalPreview } from './AgentTerminalPreview'

describe('AgentTerminalPreview Option dead-key ownership', () => {
  const connect = vi.fn()
  const input = vi.fn(async () => true)

  beforeEach(() => {
    terminalHarness.instances.length = 0
    storeState.settings = null
    connect.mockResolvedValue({
      snapshot: { data: '', cols: 80, rows: 24, seq: 1, kittyKeyboardFlags: 2 },
      replay: []
    })
    Object.assign(window, {
      api: {
        terminalPreview: {
          connect,
          input,
          fit: vi.fn(async (_ptyId: string, cols: number, rows: number) => ({ cols, rows })),
          ack: vi.fn(async () => undefined),
          unsubscribe: vi.fn(async () => undefined),
          onData: () => vi.fn()
        },
        ui: {
          readClipboardText: vi.fn(async () => ''),
          writeClipboardText: vi.fn(async () => undefined),
          writeTerminalClipboardText: vi.fn(async () => undefined),
          onAppMenuPaste: () => vi.fn(),
          onAppMenuSelectionAction: () => vi.fn(),
          performNativeSelectionAction: vi.fn()
        }
      }
    })
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  async function renderPreview(): Promise<PreviewTerminal> {
    render(<AgentTerminalPreview ptyId="pty-1" />)
    await waitFor(() => expect(terminalHarness.instances).toHaveLength(1))
    const terminal = terminalHarness.instances[0]!
    await waitFor(() => expect(terminal.customKeyHandler).not.toBeNull())
    return terminal
  }

  function deadKeyEvents(): { keydown: KeyboardEvent; keyup: KeyboardEvent } {
    return {
      keydown: new KeyboardEvent('keydown', {
        key: 'Dead',
        code: 'KeyE',
        altKey: true,
        cancelable: true
      }),
      keyup: new KeyboardEvent('keyup', {
        key: '´',
        code: 'KeyE',
        altKey: true,
        cancelable: true
      })
    }
  }

  it('preserves native dead-key keydown and consumes its rewritten keyup', async () => {
    const terminal = await renderPreview()
    const events = deadKeyEvents()

    expect(terminal.customKeyHandler!(events.keydown)).toBe(true)
    expect(events.keydown.defaultPrevented).toBe(false)
    expect(terminal.customKeyHandler!(events.keyup)).toBe(false)
    expect(events.keyup.defaultPrevented).toBe(true)
    expect(terminal.input).not.toHaveBeenCalled()
  })

  it('sends a configured-side dead key once and consumes its rewritten keyup', async () => {
    storeState.settings = { terminalMacOptionAsAlt: 'left' }
    const terminal = await renderPreview()
    window.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Alt',
        code: 'AltLeft',
        location: 1,
        altKey: true
      })
    )
    const events = deadKeyEvents()

    expect(terminal.customKeyHandler!(events.keydown)).toBe(false)
    expect(events.keydown.defaultPrevented).toBe(true)
    expect(terminal.input).toHaveBeenCalledExactlyOnceWith('\x1be')
    expect(terminal.customKeyHandler!(events.keyup)).toBe(false)
    expect(events.keyup.defaultPrevented).toBe(true)
    expect(terminal.input).toHaveBeenCalledExactlyOnceWith('\x1be')
  })
})
