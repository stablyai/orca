// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { copyTerminalSelectionFromUserInput } from './terminal-selection-copy'

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
})
