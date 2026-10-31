// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CLIPBOARD_IMAGE_MAX_PIXELS,
  CLIPBOARD_IMAGE_MAX_SOURCE_BYTES,
  CLIPBOARD_IMAGE_TOO_LARGE_ERROR
} from '../../../shared/clipboard-image'
import { convertImageBlobToPng } from './image-blob-png'

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])
const WEBP_BYTES = new TextEncoder().encode('RIFF\u0000\u0000\u0000WEBPVP8 ')
const originalCanvasGetContext = Object.getOwnPropertyDescriptor(
  HTMLCanvasElement.prototype,
  'getContext'
)

function stubDecodedSize(
  width: number,
  height: number,
  decode = vi.fn().mockResolvedValue(undefined)
) {
  vi.stubGlobal(
    'Image',
    class {
      src = ''
      naturalWidth = width
      naturalHeight = height
      decode = decode
    }
  )
  return decode
}

function stubCanvas(png: Blob | null = new Blob([PNG_BYTES], { type: 'image/png' })) {
  const dimensions = { width: 0, height: 0 }
  const drawImage = vi.fn()
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    value: () => ({ drawImage }),
    configurable: true
  })
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (
    this: HTMLCanvasElement,
    callback
  ) {
    dimensions.width = this.width
    dimensions.height = this.height
    callback(png)
  })
  return { dimensions, drawImage, png }
}

beforeEach(() => {
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:decode-owned')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  if (originalCanvasGetContext) {
    Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', originalCanvasGetContext)
  }
})

describe('convertImageBlobToPng', () => {
  it('validates dimensions and returns PNG signature bytes unchanged', async () => {
    const decode = stubDecodedSize(800, 600)
    const png = new Blob([PNG_BYTES], { type: 'image/png' })

    await expect(convertImageBlobToPng(png)).resolves.toBe(png)

    expect(decode).toHaveBeenCalledOnce()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:decode-owned')
  })

  it.each([
    ['a non-PNG mislabeled as PNG', () => new Blob([WEBP_BYTES], { type: 'image/png' })],
    [
      'SVG',
      () =>
        new Blob(['<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"></svg>'], {
          type: 'image/svg+xml'
        })
    ]
  ])(
    'decodes %s with an image element and encodes its natural dimensions',
    async (_name, source) => {
      stubDecodedSize(800, 600)
      const { dimensions, drawImage, png } = stubCanvas()

      await expect(convertImageBlobToPng(source())).resolves.toBe(png)

      expect(dimensions.width).toBe(800)
      expect(dimensions.height).toBe(600)
      expect(drawImage).toHaveBeenCalledOnce()
      expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:decode-owned')
    }
  )

  it.each([
    ['image/svg+xml', 2000, 1000, 128, 64],
    ['image/png', 20, 40, 20, 40]
  ])(
    'fits %s within an icon edge without upscaling',
    async (type, width, height, wantWidth, wantHeight) => {
      stubDecodedSize(width, height)
      const { dimensions, png } = stubCanvas()
      const source = new Blob([type === 'image/png' ? PNG_BYTES : WEBP_BYTES], { type })

      await expect(convertImageBlobToPng(source, { maxEdge: 128 })).resolves.toBe(png)

      expect(dimensions).toEqual({ width: wantWidth, height: wantHeight })
      expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:decode-owned')
    }
  )
  it('rejects excessive source bytes before creating a decode URL', async () => {
    await expect(
      convertImageBlobToPng(new Blob([new Uint8Array(CLIPBOARD_IMAGE_MAX_SOURCE_BYTES + 1)]))
    ).rejects.toThrow(CLIPBOARD_IMAGE_TOO_LARGE_ERROR)
    expect(URL.createObjectURL).not.toHaveBeenCalled()
  })

  it('rejects excessive PNG dimensions and releases its decode URL', async () => {
    stubDecodedSize(CLIPBOARD_IMAGE_MAX_PIXELS + 1, 1)

    await expect(
      convertImageBlobToPng(new Blob([PNG_BYTES], { type: 'image/png' }))
    ).rejects.toThrow(CLIPBOARD_IMAGE_TOO_LARGE_ERROR)
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:decode-owned')
  })

  it('releases its temporary URL on a decode error', async () => {
    stubDecodedSize(800, 600, vi.fn().mockRejectedValue(new Error('invalid image')))

    await expect(convertImageBlobToPng(new Blob(['invalid']))).rejects.toThrow('invalid image')
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:decode-owned')
  })

  it.each([null, new Blob([new Uint8Array(CLIPBOARD_IMAGE_MAX_SOURCE_BYTES + 1)])])(
    'releases its temporary URL when PNG encoding fails or exceeds the byte cap',
    async (png) => {
      stubDecodedSize(800, 600)
      stubCanvas(png)

      await expect(convertImageBlobToPng(new Blob([WEBP_BYTES]))).rejects.toThrow(
        png ? CLIPBOARD_IMAGE_TOO_LARGE_ERROR : 'Clipboard image could not be encoded as PNG'
      )
      expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:decode-owned')
    }
  )
})
