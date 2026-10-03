// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CLIPBOARD_IMAGE_MAX_PIXELS,
  CLIPBOARD_IMAGE_TOO_LARGE_ERROR
} from '../../../shared/clipboard-image'
import { convertImageBlobToPng } from './image-blob-png'

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])
const WEBP_BYTES = new TextEncoder().encode('RIFF\u0000\u0000\u0000\u0000WEBPVP8 ')

function stubDecodedSize(width: number, height: number): ReturnType<typeof vi.fn> {
  const close = vi.fn()
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(async () => ({ width, height, close }))
  )
  return close
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('convertImageBlobToPng', () => {
  it('returns a PNG unchanged instead of re-encoding it', async () => {
    const close = stubDecodedSize(800, 600)
    const png = new Blob([PNG_BYTES], { type: 'image/png' })

    await expect(convertImageBlobToPng(png)).resolves.toBe(png)
    expect(close).toHaveBeenCalledOnce()
  })

  it('converts an image whose name says PNG but whose bytes are another format', async () => {
    stubDecodedSize(800, 600)

    // Why: happy-dom has no 2D canvas, so reaching the conversion path rejects here.
    await expect(
      convertImageBlobToPng(new Blob([WEBP_BYTES], { type: 'image/png' }))
    ).rejects.toThrow('Clipboard image could not be decoded')
  })

  it('still rejects a PNG whose dimensions exceed the clipboard limit', async () => {
    stubDecodedSize(CLIPBOARD_IMAGE_MAX_PIXELS + 1, 1)

    await expect(
      convertImageBlobToPng(new Blob([PNG_BYTES], { type: 'image/png' }))
    ).rejects.toThrow(CLIPBOARD_IMAGE_TOO_LARGE_ERROR)
  })
})
