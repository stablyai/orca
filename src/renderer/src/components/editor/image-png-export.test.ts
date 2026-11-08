// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { imageClipboardPngDataUrl, imagePngLayout } from './image-png-export'

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='

describe('imagePngLayout', () => {
  it('doubles small images for crisp text', () => {
    expect(imagePngLayout({ width: 300, height: 100 })).toEqual({
      width: 600,
      height: 200,
      pixelRatio: 2
    })
  })

  it('scales down to stay inside the clipboard pixel budget and canvas side limit', () => {
    const budget = imagePngLayout({ width: 4000, height: 4000 }, 1_000_000)
    expect(budget!.width * budget!.height).toBeLessThanOrEqual(1_000_000)
    const wide = imagePngLayout({ width: 40_000, height: 10 })
    expect(wide!.width).toBeLessThanOrEqual(16384)
  })

  it('refuses an image with no size', () => {
    expect(imagePngLayout({ width: 0, height: 10 })).toBeNull()
  })
})

describe('imageClipboardPngDataUrl', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('copies a raster PNG as its own bytes instead of a 2x render', async () => {
    const bytes = Uint8Array.from(atob(PNG_BASE64), (character) => character.charCodeAt(0))
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new Blob([bytes], { type: 'image/png' })))
    )
    vi.stubGlobal(
      'Image',
      class {
        src = ''
        naturalWidth = 1
        naturalHeight = 1
        decode = async (): Promise<void> => undefined
      }
    )
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:decode')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)

    await expect(
      imageClipboardPngDataUrl('blob:image', { width: 1, height: 1 }, null)
    ).resolves.toBe(`data:image/png;base64,${PNG_BASE64}`)
  })
})
