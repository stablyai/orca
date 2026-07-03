import { describe, expect, it, vi } from 'vitest'
import { copyTerminalSelection } from './terminal-selection-copy'

function makeTerminal(selection: string) {
  return {
    getSelection: vi.fn(() => selection),
    clearSelection: vi.fn()
  }
}

describe('copyTerminalSelection', () => {
  it('writes selected terminal text to the clipboard', async () => {
    const terminal = makeTerminal('copilot answer')
    const writeClipboardText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue()

    await expect(copyTerminalSelection({ terminal, writeClipboardText })).resolves.toBe(true)

    expect(writeClipboardText).toHaveBeenCalledWith('copilot answer')
    expect(terminal.clearSelection).not.toHaveBeenCalled()
  })

  it('does not claim success for an empty xterm selection', async () => {
    const terminal = makeTerminal('')
    const writeClipboardText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue()

    await expect(copyTerminalSelection({ terminal, writeClipboardText })).resolves.toBe(false)

    expect(writeClipboardText).not.toHaveBeenCalled()
    expect(terminal.clearSelection).not.toHaveBeenCalled()
  })

  it('clears xterm selection only after the clipboard write succeeds', async () => {
    const terminal = makeTerminal('copilot answer')
    const writeClipboardText = vi
      .fn<(text: string) => Promise<void>>()
      .mockRejectedValue(new Error('clipboard unchanged'))

    await expect(
      copyTerminalSelection({ terminal, writeClipboardText, clearSelectionOnSuccess: true })
    ).rejects.toThrow('clipboard unchanged')

    expect(terminal.clearSelection).not.toHaveBeenCalled()
  })

  it('clears the xterm selection after a successful write when requested', async () => {
    const terminal = makeTerminal('copilot answer')
    const writeClipboardText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue()

    await expect(
      copyTerminalSelection({ terminal, writeClipboardText, clearSelectionOnSuccess: true })
    ).resolves.toBe(true)

    expect(terminal.clearSelection).toHaveBeenCalledTimes(1)
  })
})
