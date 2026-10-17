// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { copyTerminalSelectionFromUserInput } from './terminal-selection-copy'

vi.mock('@/store', () => ({ useAppStore: { getState: () => ({ settings: {} }) } }))

const writeTerminalClipboardText = vi.fn<(text: string) => Promise<void>>()
const performNativeSelectionAction = vi.fn()
let platform: { platform: string; displayServer?: string }

/** Uses a real textarea so automatic-copy focus regressions remain observable. */
function makeTerminal(selection = '  first line\n  second line') {
  const textarea = document.createElement('textarea')
  document.body.appendChild(textarea)
  return {
    textarea,
    getSelection: () => selection,
    clearSelection: vi.fn(),
    focus: vi.fn()
  }
}

describe('copyTerminalSelectionFromUserInput', () => {
  beforeEach(() => {
    platform = { platform: 'linux', displayServer: 'wayland' }
    writeTerminalClipboardText.mockReset().mockResolvedValue(undefined)
    performNativeSelectionAction.mockReset().mockResolvedValue(true)
    vi.stubGlobal('api', {
      platform: { get: () => platform },
      ui: { writeTerminalClipboardText, performNativeSelectionAction }
    })
  })

  afterEach(() => {
    document.body.innerHTML = ''
    vi.unstubAllGlobals()
  })

  it('copies a focused Wayland terminal natively without moving focus or clearing its selection', async () => {
    const terminal = makeTerminal()
    terminal.textarea.focus()

    await copyTerminalSelectionFromUserInput(terminal, 'selection')

    expect(performNativeSelectionAction).toHaveBeenCalledExactlyOnceWith('copy')
    expect(writeTerminalClipboardText).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(terminal.textarea)
    expect(terminal.focus).not.toHaveBeenCalled()
    expect(terminal.clearSelection).not.toHaveBeenCalled()
    expect(terminal.getSelection()).toBe('  first line\n  second line')
  })

  it('keeps search input focused when search programmatically selects terminal text', async () => {
    const terminal = makeTerminal()
    const searchInput = document.createElement('input')
    document.body.appendChild(searchInput)
    searchInput.focus()

    await copyTerminalSelectionFromUserInput(terminal, 'selection')

    expect(performNativeSelectionAction).not.toHaveBeenCalled()
    expect(writeTerminalClipboardText).toHaveBeenCalledExactlyOnceWith('first line\nsecond line')
    expect(document.activeElement).toBe(searchInput)
    expect(terminal.focus).not.toHaveBeenCalled()
    expect(terminal.clearSelection).not.toHaveBeenCalled()
  })

  it('retains the existing writer before a terminal textarea is attached', async () => {
    const terminal = { ...makeTerminal(), textarea: undefined }

    await copyTerminalSelectionFromUserInput(terminal, 'selection')

    expect(performNativeSelectionAction).not.toHaveBeenCalled()
    expect(writeTerminalClipboardText).toHaveBeenCalledExactlyOnceWith('first line\nsecond line')
    expect(terminal.focus).not.toHaveBeenCalled()
  })

  it('leaves the clipboard unchanged for an empty focused terminal selection', async () => {
    const terminal = makeTerminal('')
    terminal.textarea.focus()

    await copyTerminalSelectionFromUserInput(terminal, 'selection')

    expect(performNativeSelectionAction).not.toHaveBeenCalled()
    expect(writeTerminalClipboardText).not.toHaveBeenCalled()
    expect(terminal.clearSelection).not.toHaveBeenCalled()
  })

  it.each([
    { platform: 'linux', displayServer: 'x11' },
    { platform: 'linux' },
    { platform: 'darwin' },
    { platform: 'win32' }
  ])('preserves the existing publisher on $platform / $displayServer', async (current) => {
    platform = current
    const terminal = makeTerminal()
    terminal.textarea.focus()

    await copyTerminalSelectionFromUserInput(terminal, 'selection')

    expect(performNativeSelectionAction).not.toHaveBeenCalled()
    expect(writeTerminalClipboardText).toHaveBeenCalledExactlyOnceWith('first line\nsecond line')
    expect(terminal.focus).not.toHaveBeenCalled()
    expect(terminal.clearSelection).not.toHaveBeenCalled()
  })

  it('keeps a background selection available for retry when its existing publisher fails', async () => {
    const terminal = makeTerminal()
    writeTerminalClipboardText.mockRejectedValue(new Error('clipboard write failed'))

    await expect(copyTerminalSelectionFromUserInput(terminal, 'selection')).rejects.toThrow(
      'clipboard write failed'
    )

    expect(performNativeSelectionAction).not.toHaveBeenCalled()
    expect(terminal.focus).not.toHaveBeenCalled()
    expect(terminal.clearSelection).not.toHaveBeenCalled()
  })
})
