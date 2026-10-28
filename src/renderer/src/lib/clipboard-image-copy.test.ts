// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { copyImageToClipboard } from './clipboard-image-copy'

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='
const png = new Blob([Uint8Array.from(atob(PNG_BASE64), (character) => character.charCodeAt(0))], {
  type: 'image/png'
})
const writeClipboardImage = vi.fn<(dataUrl: string) => Promise<void>>()
const decode = vi.fn<() => Promise<void>>()

beforeEach(() => {
  writeClipboardImage.mockResolvedValue(undefined)
  decode.mockResolvedValue(undefined)
  vi.stubGlobal('api', { ui: { writeClipboardImage } })
  vi.stubGlobal(
    'Image',
    class {
      src = ''
      naturalWidth = 1
      naturalHeight = 1
      decode = decode
    }
  )
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:decode-owned')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  writeClipboardImage.mockReset()
  decode.mockReset()
})

describe('copyImageToClipboard', () => {
  it('writes the original PNG bytes and waits for the local clipboard write', async () => {
    const write = Promise.withResolvers<void>()
    writeClipboardImage.mockReturnValue(write.promise)
    let finished = false

    const copying = copyImageToClipboard(png).then(() => {
      finished = true
    })

    await vi.waitFor(() => {
      expect(writeClipboardImage).toHaveBeenCalledWith(`data:image/png;base64,${PNG_BASE64}`)
    })
    expect(finished).toBe(false)

    write.resolve()
    await copying
    expect(finished).toBe(true)
  })

  it('propagates a decode failure without writing to the clipboard', async () => {
    const error = new Error('Invalid image')
    decode.mockRejectedValue(error)

    await expect(copyImageToClipboard(png)).rejects.toBe(error)

    expect(writeClipboardImage).not.toHaveBeenCalled()
  })

  it('propagates a local clipboard write failure', async () => {
    const error = new Error('Clipboard unavailable')
    writeClipboardImage.mockRejectedValue(error)

    await expect(copyImageToClipboard(png)).rejects.toBe(error)
  })
})
