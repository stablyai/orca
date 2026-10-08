import { afterEach, describe, expect, it, vi } from 'vitest'
import { decodeRemoteBrowserFrameUrl } from './remote-browser-page-input-model'

function installImage(decodeAvailable = true) {
  let resolveDecode!: () => void
  let rejectDecode!: (error: Error) => void
  const done = new Promise<void>((resolve, reject) => {
    resolveDecode = resolve
    rejectDecode = reject
  })
  const decode = vi.fn(() => done)
  const removeAttribute = vi.fn()
  const image: {
    decoding: string
    src: string
    onload: (() => void) | null
    onerror: (() => void) | null
    removeAttribute: typeof removeAttribute
    decode?: typeof decode
  } = {
    decoding: '',
    src: '',
    onload: null,
    onerror: null,
    removeAttribute,
    ...(decodeAvailable ? { decode } : {})
  }
  vi.stubGlobal('window', {
    Image: vi.fn(function () {
      return image
    })
  })
  return { image, decode, removeAttribute, resolveDecode, rejectDecode }
}

afterEach(() => vi.unstubAllGlobals())

describe('remote browser frame decode cancellation', () => {
  it('waits for decode and removes its abort listener after success', async () => {
    const fake = installImage()
    const controller = new AbortController()
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener')
    const done = decodeRemoteBrowserFrameUrl('blob:frame', controller.signal)
    expect(fake.image.src).toBe('blob:frame')
    expect(fake.image.decoding).toBe('async')
    fake.resolveDecode()
    await done
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function))
    controller.abort()
    expect(fake.removeAttribute).not.toHaveBeenCalled()
  })

  it('stops the image load and settles a retired decode without waiting for it', async () => {
    const fake = installImage()
    const controller = new AbortController()
    const done = decodeRemoteBrowserFrameUrl('blob:frame', controller.signal)
    controller.abort()
    await expect(done).rejects.toThrow('cancelled')
    expect(fake.removeAttribute).toHaveBeenCalledWith('src')
    expect(fake.image.onload).toBeNull()
    expect(fake.image.onerror).toBeNull()
    fake.resolveDecode()
    await Promise.resolve()
  })

  it('does not start an already cancelled image decode', async () => {
    const fake = installImage()
    const controller = new AbortController()
    controller.abort()
    await expect(decodeRemoteBrowserFrameUrl('blob:frame', controller.signal)).rejects.toThrow(
      'cancelled'
    )
    expect(fake.decode).not.toHaveBeenCalled()
    expect(fake.image.src).toBe('')
  })

  it('removes the listener when image decode fails', async () => {
    const fake = installImage()
    const controller = new AbortController()
    const done = decodeRemoteBrowserFrameUrl('blob:frame', controller.signal)
    fake.rejectDecode(new Error('invalid image'))
    await expect(done).rejects.toThrow('invalid image')
    controller.abort()
    expect(fake.removeAttribute).not.toHaveBeenCalled()
  })

  it('cleans up a synchronous decoder failure', async () => {
    const fake = installImage()
    fake.decode.mockImplementation(() => {
      throw new Error('decoder unavailable')
    })
    const controller = new AbortController()
    await expect(decodeRemoteBrowserFrameUrl('blob:frame', controller.signal)).rejects.toThrow(
      'decoder unavailable'
    )
    controller.abort()
    expect(fake.removeAttribute).not.toHaveBeenCalled()
  })

  it('uses load completion when decode is unavailable', async () => {
    const fake = installImage(false)
    const done = decodeRemoteBrowserFrameUrl('blob:frame')
    fake.image.onload?.()
    await done
    expect(fake.image.onload).toBeNull()
    expect(fake.image.onerror).toBeNull()
  })

  it('cancels the load-event fallback too', async () => {
    const fake = installImage(false)
    const controller = new AbortController()
    const done = decodeRemoteBrowserFrameUrl('blob:frame', controller.signal)
    controller.abort()
    await expect(done).rejects.toThrow('cancelled')
    expect(fake.image.onload).toBeNull()
    expect(fake.image.onerror).toBeNull()
  })
})
