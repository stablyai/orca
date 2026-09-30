import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

beforeEach(() => {
  vi.resetModules()
  vi.stubGlobal('window', {
    localStorage: {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {}
    }
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

async function loadClipboardHasImage(): Promise<() => Promise<boolean | null>> {
  const module = await import('./web-clipboard-api')
  return module.clipboardHasImage
}

describe('clipboardHasImage', () => {
  it('detects an image from clipboard types without reading the payload', async () => {
    const getType = vi.fn()
    const read = vi.fn().mockResolvedValue([
      {
        types: ['text/plain', 'image/png'],
        getType
      }
    ])
    vi.stubGlobal('navigator', { clipboard: { read } })
    const clipboardHasImage = await loadClipboardHasImage()

    await expect(clipboardHasImage()).resolves.toBe(true)
    expect(read).toHaveBeenCalledOnce()
    expect(getType).not.toHaveBeenCalled()
  })

  it('returns false when the clipboard lists no image type', async () => {
    const read = vi.fn().mockResolvedValue([{ types: ['text/plain'], getType: vi.fn() }])
    vi.stubGlobal('navigator', { clipboard: { read } })
    const clipboardHasImage = await loadClipboardHasImage()

    await expect(clipboardHasImage()).resolves.toBe(false)
  })

  it('returns null when the clipboard cannot be read for images', async () => {
    vi.stubGlobal('navigator', { clipboard: { readText: vi.fn() } })
    const clipboardHasImage = await loadClipboardHasImage()

    await expect(clipboardHasImage()).resolves.toBeNull()
  })

  it('rejects when the clipboard read fails instead of reporting no image', async () => {
    const read = vi.fn().mockRejectedValue(new Error('clipboard changed'))
    vi.stubGlobal('navigator', { clipboard: { read } })
    const clipboardHasImage = await loadClipboardHasImage()

    await expect(clipboardHasImage()).rejects.toThrow('clipboard changed')
  })
})
