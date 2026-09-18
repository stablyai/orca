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
import { dispatchAppMenuPasteEvent } from '@/lib/app-menu-paste'
import { dispatchAppMenuSelectionAction } from '@/lib/app-menu-selection-actions'

import {
  terminalHarness,
  platformState,
  storeState,
  imeHarness
} from './__mocks__/preview-terminal-input'

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

  it('claims the app-menu paste event and pastes while the preview owns focus', async () => {
    const view = render(<AgentTerminalPreview ptyId="pty-1" />)
    await waitFor(() => expect(terminalHarness.instances).toHaveLength(1))
    const terminal = terminalHarness.instances[0]!
    focusInsidePreview(view.container)

    let claimed = false
    act(() => {
      claimed = dispatchAppMenuPasteEvent()
    })

    // The claim is what keeps App-level paste out of xterm's hidden textarea.
    expect(claimed).toBe(true)
    await waitFor(() => expect(terminal.paste).toHaveBeenCalledWith('clip-text'))
    expect(input).toHaveBeenCalledWith('pty-1', 'clip-text')
  })

  it('encodes a leading newline for a remote Windows Codex preview without submitting', async () => {
    readClipboardText.mockResolvedValueOnce('\nsecond line')
    const view = render(
      <AgentTerminalPreview
        ptyId="remote:windows-box@@pty-1"
        terminalInput={{
          hostPlatform: 'win32',
          localWindowsConpty: false,
          windowsShiftEnterEncoding: 'alt-enter',
          windowsInputRecordPasteNewline: 'alt-enter',
          ctrlEnterCsiU: false,
          kittyKeyboardAdvertised: false
        }}
      />
    )
    await waitFor(() => expect(terminalHarness.instances).toHaveLength(1))
    const terminal = terminalHarness.instances[0]!
    focusInsidePreview(view.container)

    act(() => {
      dispatchAppMenuPasteEvent()
    })

    await waitFor(() =>
      expect(input).toHaveBeenCalledWith('remote:windows-box@@pty-1', '\x1b\rsecond line')
    )
    expect(terminal.input).toHaveBeenCalledWith('\x1b\rsecond line')
    expect(terminal.paste).not.toHaveBeenCalled()
  })

  it('claims app-menu selection actions while the preview owns focus', async () => {
    const view = render(<AgentTerminalPreview ptyId="pty-1" />)
    await waitFor(() => expect(terminalHarness.instances).toHaveLength(1))
    const terminal = terminalHarness.instances[0]!
    terminal.selectionText = 'selected text'
    const focusTarget = focusInsidePreview(view.container, 'textarea')
    focusTarget.className = 'xterm-helper-textarea'

    let selectAllClaimed = false
    let copyClaimed = false
    act(() => {
      selectAllClaimed = dispatchAppMenuSelectionAction('select-all')
    })
    act(() => {
      copyClaimed = dispatchAppMenuSelectionAction('copy')
    })

    expect(selectAllClaimed).toBe(true)
    expect(copyClaimed).toBe(true)
    expect(terminal.selectAll).toHaveBeenCalledOnce()
    await waitFor(() => expect(writeTerminalClipboardText).toHaveBeenCalledWith('selected text'))
  })

  it('leaves app-menu selection actions unclaimed for text controls inside the preview', async () => {
    const view = render(<AgentTerminalPreview ptyId="pty-1" />)
    await waitFor(() => expect(terminalHarness.instances).toHaveLength(1))
    const terminal = terminalHarness.instances[0]!
    focusInsidePreview(view.container)

    let claimed = true
    act(() => {
      claimed = dispatchAppMenuSelectionAction('select-all')
    })

    // Unclaimed so the App-level handler performs the native selection action.
    expect(claimed).toBe(false)
    expect(terminal.selectAll).not.toHaveBeenCalled()
  })

  it('leaves a copy action with no terminal selection unclaimed', async () => {
    render(<AgentTerminalPreview ptyId="pty-1" />)
    await waitFor(() => expect(terminalHarness.instances).toHaveLength(1))

    let claimed = true
    act(() => {
      claimed = dispatchAppMenuSelectionAction('copy')
    })

    expect(claimed).toBe(false)
    expect(writeTerminalClipboardText).not.toHaveBeenCalled()
  })

  it('leaves the app-menu paste event unclaimed when focus is outside the preview', async () => {
    render(<AgentTerminalPreview ptyId="pty-1" />)
    await waitFor(() => expect(terminalHarness.instances).toHaveLength(1))

    let claimed = true
    await act(async () => {
      claimed = dispatchAppMenuPasteEvent()
    })

    expect(claimed).toBe(false)
    expect(readClipboardText).not.toHaveBeenCalled()
    expect(terminalHarness.instances[0]!.paste).not.toHaveBeenCalled()
  })

  it('stops claiming app-menu clipboard events once unmounted', async () => {
    const view = render(<AgentTerminalPreview ptyId="pty-1" />)
    await waitFor(() => expect(terminalHarness.instances).toHaveLength(1))
    focusInsidePreview(view.container)
    view.unmount()

    expect(dispatchAppMenuPasteEvent()).toBe(false)
    expect(dispatchAppMenuSelectionAction('select-all')).toBe(false)
  })

  it('pastes on plain Ctrl+V on Windows, where no Edit-menu accelerator ever fires', async () => {
    platformState.value = 'win32'
    const view = render(<AgentTerminalPreview ptyId="pty-1" />)
    await waitFor(() => expect(terminalHarness.instances).toHaveLength(1))
    const terminal = terminalHarness.instances[0]!
    await waitFor(() => expect(terminal.customKeyHandler).not.toBeNull())
    focusInsidePreview(view.container)

    const plain = new KeyboardEvent('keydown', {
      key: 'v',
      code: 'KeyV',
      ctrlKey: true,
      cancelable: true
    })
    expect(terminal.customKeyHandler!(plain)).toBe(false)
    expect(plain.defaultPrevented).toBe(true)
    await waitFor(() => expect(terminal.paste).toHaveBeenCalledWith('clip-text'))

    // The repeat is swallowed without a second clipboard read, and so is the keyup.
    expect(
      terminal.customKeyHandler!(
        new KeyboardEvent('keydown', { key: 'v', code: 'KeyV', ctrlKey: true, repeat: true })
      )
    ).toBe(false)
    expect(terminal.customKeyHandler!(new KeyboardEvent('keyup', { key: 'v', code: 'KeyV' }))).toBe(
      false
    )
    expect(readClipboardText).toHaveBeenCalledTimes(1)
  })

  it('handles the shifted paste chord on Linux', async () => {
    const view = render(<AgentTerminalPreview ptyId="pty-1" />)
    await waitFor(() => expect(terminalHarness.instances).toHaveLength(1))
    const terminal = terminalHarness.instances[0]!
    await waitFor(() => expect(terminal.customKeyHandler).not.toBeNull())
    focusInsidePreview(view.container)

    const shifted = new KeyboardEvent('keydown', {
      key: 'V',
      code: 'KeyV',
      ctrlKey: true,
      shiftKey: true,
      cancelable: true
    })
    expect(terminal.customKeyHandler!(shifted)).toBe(false)
    expect(shifted.defaultPrevented).toBe(true)
    await waitFor(() => expect(terminal.paste).toHaveBeenCalledWith('clip-text'))
    expect(readClipboardText).toHaveBeenCalledTimes(1)
  })

  it('leaves plain Cmd+V to the macOS Edit-menu accelerator', async () => {
    platformState.value = 'darwin'
    const view = render(<AgentTerminalPreview ptyId="pty-1" />)
    await waitFor(() => expect(terminalHarness.instances).toHaveLength(1))
    const terminal = terminalHarness.instances[0]!
    await waitFor(() => expect(terminal.customKeyHandler).not.toBeNull())
    focusInsidePreview(view.container)

    // Why deferred: macOS keeps a real Cmd+V accelerator, so handling it here
    // AND letting the menu fire would paste twice.
    const plain = terminal.customKeyHandler!(
      new KeyboardEvent('keydown', { key: 'v', code: 'KeyV', metaKey: true })
    )
    expect(plain).toBe(true)
    expect(readClipboardText).not.toHaveBeenCalled()
  })

  it('pastes on terminal-style right-click when the setting is on', async () => {
    storeState.settings = { terminalRightClickToPaste: true }
    const view = render(<AgentTerminalPreview ptyId="pty-1" />)
    await waitFor(() => expect(terminalHarness.instances).toHaveLength(1))
    const terminal = terminalHarness.instances[0]!
    focusInsidePreview(view.container)
    const host = view.container.querySelector<HTMLElement>('.origin-bottom-left')!

    const menuEvent = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    act(() => {
      host.dispatchEvent(menuEvent)
    })

    expect(menuEvent.defaultPrevented).toBe(true)
    await waitFor(() => expect(terminal.paste).toHaveBeenCalledWith('clip-text'))
  })

  it('copies the selection on terminal-style right-click instead of pasting', async () => {
    storeState.settings = { terminalRightClickToPaste: true }
    const view = render(<AgentTerminalPreview ptyId="pty-1" />)
    await waitFor(() => expect(terminalHarness.instances).toHaveLength(1))
    const terminal = terminalHarness.instances[0]!
    terminal.selectionText = 'selected text'
    focusInsidePreview(view.container)
    const host = view.container.querySelector<HTMLElement>('.origin-bottom-left')!

    act(() => {
      host.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    })

    await waitFor(() => expect(writeTerminalClipboardText).toHaveBeenCalledWith('selected text'))
    expect(readClipboardText).not.toHaveBeenCalled()
  })

  it('leaves right-click to the native menu when the setting is off', async () => {
    storeState.settings = { terminalRightClickToPaste: false }
    const view = render(<AgentTerminalPreview ptyId="pty-1" />)
    await waitFor(() => expect(terminalHarness.instances).toHaveLength(1))
    focusInsidePreview(view.container)
    const host = view.container.querySelector<HTMLElement>('.origin-bottom-left')!

    const menuEvent = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    act(() => {
      host.dispatchEvent(menuEvent)
    })

    expect(menuEvent.defaultPrevented).toBe(false)
    expect(readClipboardText).not.toHaveBeenCalled()
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
