import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  PRIMARY_SELECTION_MAX_LENGTH,
  getPrimarySelectionText,
  readPrimarySelectionText,
  resetPrimarySelectionForTests,
  setPrimarySelectionEnabled,
  setPrimarySelectionText,
  shouldUseSystemPrimarySelectionClipboard
} from './primary-selection'

describe('primary selection buffer', () => {
  beforeEach(() => {
    resetPrimarySelectionForTests()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('ignores writes while disabled', () => {
    expect(setPrimarySelectionText('hello')).toBe(false)
    expect(getPrimarySelectionText()).toBe('')
  })

  it('stores selected text while enabled', () => {
    setPrimarySelectionEnabled(true)

    expect(setPrimarySelectionText('hello')).toBe(true)
    expect(getPrimarySelectionText()).toBe('hello')
  })

  it('keeps the current buffer when a selection is empty or too large', () => {
    setPrimarySelectionEnabled(true)
    setPrimarySelectionText('current')

    expect(setPrimarySelectionText('')).toBe(false)
    expect(getPrimarySelectionText()).toBe('current')

    expect(setPrimarySelectionText('x'.repeat(PRIMARY_SELECTION_MAX_LENGTH + 1))).toBe(false)
    expect(getPrimarySelectionText()).toBe('current')
  })

  it('clears the buffer when disabled', () => {
    setPrimarySelectionEnabled(true)
    setPrimarySelectionText('hello')

    setPrimarySelectionEnabled(false)

    expect(getPrimarySelectionText()).toBe('')
  })

  it('uses the system selection clipboard on Linux when the preload API exists', async () => {
    const readSelectionClipboardText = vi.fn(async () => 'from-system')
    const writeSelectionClipboardText = vi.fn(async () => {})
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' })
    vi.stubGlobal('window', {
      api: {
        ui: {
          readSelectionClipboardText,
          writeSelectionClipboardText
        }
      }
    })
    setPrimarySelectionEnabled(true)

    expect(shouldUseSystemPrimarySelectionClipboard()).toBe(true)
    expect(setPrimarySelectionText('hello')).toBe(true)
    expect(writeSelectionClipboardText).toHaveBeenCalledWith('hello')
    await expect(readPrimarySelectionText()).resolves.toBe('from-system')
    expect(readSelectionClipboardText).toHaveBeenCalled()
  })

  it('keeps the private buffer on non-Linux platforms', async () => {
    const writeSelectionClipboardText = vi.fn(async () => {})
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' })
    vi.stubGlobal('window', {
      api: {
        ui: {
          readSelectionClipboardText: vi.fn(async () => 'from-system'),
          writeSelectionClipboardText
        }
      }
    })
    setPrimarySelectionEnabled(true)

    expect(shouldUseSystemPrimarySelectionClipboard()).toBe(false)
    expect(setPrimarySelectionText('hello')).toBe(true)
    expect(writeSelectionClipboardText).not.toHaveBeenCalled()
    await expect(readPrimarySelectionText()).resolves.toBe('hello')
  })

  it('falls back to the private buffer if the system selection write fails', async () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' })
    vi.stubGlobal('window', {
      api: {
        ui: {
          readSelectionClipboardText: vi.fn(async () => {
            throw new Error('read failed')
          }),
          writeSelectionClipboardText: vi.fn(async () => {
            throw new Error('write failed')
          })
        }
      }
    })
    setPrimarySelectionEnabled(true)

    expect(setPrimarySelectionText('hello')).toBe(true)
    await Promise.resolve()
    await expect(readPrimarySelectionText()).resolves.toBe('hello')
  })

  it('falls back to the mirrored private buffer if the system selection read fails later', async () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' })
    vi.stubGlobal('window', {
      api: {
        ui: {
          readSelectionClipboardText: vi.fn(async () => {
            throw new Error('read failed')
          }),
          writeSelectionClipboardText: vi.fn(async () => {})
        }
      }
    })
    setPrimarySelectionEnabled(true)

    expect(setPrimarySelectionText('hello')).toBe(true)
    await expect(readPrimarySelectionText()).resolves.toBe('hello')
  })
})
