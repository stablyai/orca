// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

function stubCanvas() {
  const png = new Blob([PNG_BYTES], { type: 'image/png' })
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
})
