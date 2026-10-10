// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CLIPBOARD_IMAGE_TOO_LARGE_ERROR } from '../../../../shared/clipboard-image'

const calls = vi.hoisted(() =>
  vi.fn(async (_environmentId: string, method: string) => ({
    ok: true,
    result:
      method === 'clipboard.startImageUpload'
        ? { uploadId: 'upload-1' }
        : method === 'clipboard.commitImageUpload'
          ? '/tmp/preview.png'
          : {}
  }))
)
vi.mock('./web-runtime-calls', () => ({ callEnvironmentEnvelope: calls }))
vi.mock('./web-runtime-session', () => ({
  requireActiveEnvironmentOrNull: () => ({ id: 'image-owner' })
}))
import { createWebClipboardPreviewApi } from './web-clipboard-preview-api'

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4AWPQ0PjwHwAD/AJA63QQFQAAAABJRU5ErkJggg=='

function installPngClipboard(width: number, height: number) {
  const decode = vi.fn().mockResolvedValue(undefined)
  vi.stubGlobal(
    'Image',
    class {
      src = ''
      naturalWidth = width
      naturalHeight = height
      decode = decode
    }
  )
  vi.stubGlobal('navigator', {
    clipboard: {
      read: async () => [
        {
          types: ['image/png'],
          getType: async () => new Blob([Buffer.from(PNG_BASE64, 'base64')], { type: 'image/png' })
        }
      ]
    }
  })
  return decode
}

beforeEach(() => {
  calls.mockClear()
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:clipboard-png')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('browser PNG preview pixel limit', () => {
  it('rejects a PNG above the shared pixel limit before upload or preview', async () => {
    const decode = installPngClipboard(8192, 4097)
    const read = vi.spyOn(FileReader.prototype, 'readAsDataURL')

    await expect(createWebClipboardPreviewApi().saveClipboardImagePreview()).rejects.toThrow(
      CLIPBOARD_IMAGE_TOO_LARGE_ERROR
    )

    expect(decode).toHaveBeenCalledOnce()
    expect(read).not.toHaveBeenCalled()
    expect(calls.mock.calls).toEqual([['image-owner', 'clipboard.imageLeaseAvailable', {}]])
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:clipboard-png')
  })

  it.each([
    [1, 1],
    [8192, 4096]
  ])('validates a %i×%i PNG and preserves its original bytes', async (width, height) => {
    const decode = installPngClipboard(width, height)
    const canvas = vi.spyOn(HTMLCanvasElement.prototype, 'getContext')

    await expect(createWebClipboardPreviewApi().saveClipboardImagePreview()).resolves.toEqual({
      path: '/tmp/preview.png',
      dataUrl: `data:image/png;base64,${PNG_BASE64}`,
      runtimeEnvironmentId: 'image-owner'
    })

    expect(decode).toHaveBeenCalledOnce()
    expect(canvas).not.toHaveBeenCalled()
    expect(calls).toHaveBeenCalledWith(
      'image-owner',
      'clipboard.appendImageUploadChunk',
      { uploadId: 'upload-1', offset: 0, contentBase64: PNG_BASE64 },
      30_000
    )
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:clipboard-png')
  })
})
