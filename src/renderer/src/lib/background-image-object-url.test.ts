// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createBackgroundImageObjectUrlApi } from './background-image-object-url'

const VALID_PNG = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
    'base64'
  )
)

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

describe('background image object URL', () => {
  const createObjectURL = vi.fn(() => 'blob:background')
  const revokeObjectURL = vi.fn()
  const decodeImage = vi.fn<(_: string) => Promise<void>>()

  beforeEach(() => {
    createObjectURL.mockReset().mockReturnValue('blob:background')
    revokeObjectURL.mockReset()
    decodeImage.mockReset().mockResolvedValue()
  })

  it('publishes a valid PNG URL only after image decode succeeds', async () => {
    const decode = deferred()
    decodeImage.mockReturnValue(decode.promise)
    const objectUrls = createBackgroundImageObjectUrlApi({
      objectUrls: { createObjectURL, revokeObjectURL },
      decodeImage
    })

    const pending = objectUrls.create(VALID_PNG, 'image/png')
    await vi.waitFor(() => expect(decodeImage).toHaveBeenCalledWith('blob:background'))
    await expect(Promise.race([pending, Promise.resolve('decode-pending')])).resolves.toBe(
      'decode-pending'
    )

    decode.resolve()
    await expect(pending).resolves.toBe('blob:background')
    expect(revokeObjectURL).not.toHaveBeenCalled()
  })

  it('revokes the object URL when browser decode rejects it', async () => {
    decodeImage.mockRejectedValue(new Error('corrupt image'))
    const objectUrls = createBackgroundImageObjectUrlApi({
      objectUrls: { createObjectURL, revokeObjectURL },
      decodeImage
    })

    await expect(objectUrls.create(VALID_PNG, 'image/png')).resolves.toBeNull()
    expect(revokeObjectURL).toHaveBeenCalledOnce()
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:background')
  })
})
