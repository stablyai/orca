import { afterEach, describe, expect, it, vi } from 'vitest'
import { copyTerminalSelection } from './terminal-selection-copy'

describe('copyTerminalSelection', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns true when write and readback match selection', async () => {
    const writeClipboardText = vi.fn().mockResolvedValue(undefined)
    const readClipboardText = vi.fn().mockResolvedValue('test selection')

    vi.stubGlobal('window', {
      api: {
        ui: {
          writeClipboardText,
          readClipboardText
        }
      }
    })

    const result = await copyTerminalSelection('test selection')
    expect(result).toBe(true)
    expect(writeClipboardText).toHaveBeenCalledWith('test selection')
    expect(readClipboardText).toHaveBeenCalled()
  })

  it('returns false when readback does not match selection', async () => {
    const writeClipboardText = vi.fn().mockResolvedValue(undefined)
    const readClipboardText = vi.fn().mockResolvedValue('something else')

    vi.stubGlobal('window', {
      api: {
        ui: {
          writeClipboardText,
          readClipboardText
        }
      }
    })

    const result = await copyTerminalSelection('test selection')
    expect(result).toBe(false)
    expect(writeClipboardText).toHaveBeenCalledWith('test selection')
    expect(readClipboardText).toHaveBeenCalled()
  })

  it('returns false on write failure', async () => {
    const writeClipboardText = vi.fn().mockRejectedValue(new Error('write failed'))
    const readClipboardText = vi.fn()

    vi.stubGlobal('window', {
      api: {
        ui: {
          writeClipboardText,
          readClipboardText
        }
      }
    })

    const result = await copyTerminalSelection('test selection')
    expect(result).toBe(false)
    expect(writeClipboardText).toHaveBeenCalledWith('test selection')
    expect(readClipboardText).not.toHaveBeenCalled()
  })

  it('returns false for empty selection', async () => {
    const result = await copyTerminalSelection('')
    expect(result).toBe(false)
  })
})
