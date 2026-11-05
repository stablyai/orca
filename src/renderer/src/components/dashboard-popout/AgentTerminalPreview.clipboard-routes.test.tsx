// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import type { ITerminalOptions } from '@xterm/xterm'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  TERMINAL_PASTE_CHUNK_MAX_BYTES,
  TERMINAL_PASTE_DIRECT_MAX_BYTES
} from '@/components/terminal-pane/terminal-paste-limits'
import '@/components/terminal-pane/terminal-bracketed-paste'
import {
  BRACKETED_PASTE_END,
  BRACKETED_PASTE_START
} from '../../../../shared/terminal/input/terminal-bracketed-paste-text'
import { dispatchAppMenuPasteEvent } from '@/lib/app-menu-paste'

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
  settings: null as { terminalRightClickToPaste?: boolean } | null,
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
      // Read the same live keyboard-mode mirror the real commit forwarder receives.
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

// Paste encoding is under test here; owner routing is covered by AgentTerminalPreview.test.tsx.
vi.mock('./terminal-preview-api', () => ({
  terminalPreviewApiFor: () => window.api.terminalPreview
}))

import { AgentTerminalPreview } from './AgentTerminalPreview'

describe('AgentTerminalPreview clipboard routes', () => {
  const input = vi.fn(async (_ptyId: string, _data: string) => true)
  const fit = vi.fn(async (_ptyId: string, cols: number, rows: number) => ({ cols, rows }))
  const ack = vi.fn(async () => {})
  const unsubscribe = vi.fn(async () => {})
  const connect = vi.fn()
  const readClipboardText = vi.fn(async () => 'clip-text')
  const writeClipboardText = vi.fn(async () => {})
  const writeTerminalClipboardText = vi.fn(async () => {})
  const performNativeSelectionAction = vi.fn()

  /** Focuses a stand-in for xterm's helper textarea inside the preview container. */
  const focusInsidePreview = (container: HTMLElement, tagName = 'input'): HTMLElement => {
    const host = container.querySelector<HTMLElement>('.origin-bottom-left')!
    const focusTarget = document.createElement(tagName)
    host.appendChild(focusTarget)
    focusTarget.focus()
    return focusTarget
  }

  beforeEach(() => {
    terminalHarness.instances.length = 0
    terminalHarness.userInputListener = null
    platformState.value = 'linux'
    storeState.keybindings = {}
    imeHarness.forwarders.length = 0
    imeHarness.trackers.length = 0
    imeHarness.claimResult = false
    storeState.settings = null
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
          onData: () => vi.fn()
        },
        ui: {
          readClipboardText,
          writeClipboardText,
          writeTerminalClipboardText,
          performNativeSelectionAction
        }
      }
    })
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
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
    focusInsidePreview(view.container)
    const outsideInput = document.createElement('input')
    view.container.appendChild(outsideInput)

    act(() => {
      dispatchAppMenuPasteEvent()
    })
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
    focusInsidePreview(view.container)

    act(() => {
      dispatchAppMenuPasteEvent()
    })
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
    focusInsidePreview(view.container)
    const outsideInput = document.createElement('input')
    view.container.appendChild(outsideInput)
    input.mockImplementationOnce(async () => {
      outsideInput.focus()
      return true
    })

    act(() => {
      dispatchAppMenuPasteEvent()
    })
    await waitFor(() => expect(input).toHaveBeenCalledTimes(2))

    expect(input.mock.calls.map(([, data]) => data)).toEqual([
      BRACKETED_PASTE_START,
      BRACKETED_PASTE_END
    ])
  })
})
