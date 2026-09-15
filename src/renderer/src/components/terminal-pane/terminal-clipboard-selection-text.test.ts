import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../../../shared/global-settings-types'

const settings: { current: Partial<GlobalSettings> } = { current: {} }

vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({ settings: settings.current }) }
}))

const { readTerminalClipboardSelection } = await import('./terminal-clipboard-selection-text')

const { copyTerminalSelection } = await import('./terminal-selection-copy')

// The gutter an agent CLI paints its message behind, as xterm reports it.
const GUTTERED = ['  Retry limit is now 5.', '  Backoff starts at 2s.'].join('\n')

const UNGUTTERED = ['Retry limit is now 5.', 'Backoff starts at 2s.'].join('\n')

describe('readTerminalClipboardSelection', () => {
  beforeEach(() => {
    settings.current = {}
  })

  it('strips the gutter by default', () => {
    expect(readTerminalClipboardSelection({ getSelection: () => GUTTERED })).toBe(UNGUTTERED)
  })

  it('strips the gutter when the setting is explicitly on', () => {
    settings.current = { terminalCopyTrimsGutter: true }
    expect(readTerminalClipboardSelection({ getSelection: () => GUTTERED })).toBe(UNGUTTERED)
  })

  it('copies screen cells verbatim when the setting is off', () => {
    settings.current = { terminalCopyTrimsGutter: false }
    expect(readTerminalClipboardSelection({ getSelection: () => GUTTERED })).toBe(GUTTERED)
  })
})

describe('copyTerminalSelection gutter handling', () => {
  beforeEach(() => {
    settings.current = {}
  })

  it('writes the un-guttered text to the clipboard', async () => {
    const writeClipboardText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue()
    await copyTerminalSelection({
      terminal: { getSelection: () => GUTTERED, clearSelection: vi.fn() },
      writeClipboardText
    })
    expect(writeClipboardText).toHaveBeenCalledWith(UNGUTTERED)
  })

  it('still reports no selection for an empty xterm selection', async () => {
    const writeClipboardText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue()
    await expect(
      copyTerminalSelection({
        terminal: { getSelection: () => '', clearSelection: vi.fn() },
        writeClipboardText
      })
    ).resolves.toBe(false)
    expect(writeClipboardText).not.toHaveBeenCalled()
  })
})
