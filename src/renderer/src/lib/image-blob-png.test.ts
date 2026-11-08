// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CLIPBOARD_IMAGE_MAX_PIXELS,
  CLIPBOARD_IMAGE_MAX_SOURCE_BYTES,
  CLIPBOARD_IMAGE_TOO_LARGE_ERROR
} from '../../../shared/clipboard-image'
import { convertImageBlobToPng } from './image-blob-png'

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])
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
})
