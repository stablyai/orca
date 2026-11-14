// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { blobToBase64 } from './image-blob-png'

afterEach(() => vi.unstubAllGlobals())

it('aborts an active image read and settles both active and already-retired reads', async () => {
  const abort = vi.fn()
  vi.stubGlobal(
    'FileReader',
    class {
      onabort: (() => void) | null = null
      readAsDataURL() {}
      abort() {
        abort()
        this.onabort?.()
      }
    }
  )
  const controller = new AbortController()
  const pending = blobToBase64(new Blob(['image']), controller.signal)
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  controller.abort()
  await rejected
  expect(abort).toHaveBeenCalledOnce()
  await expect(blobToBase64(new Blob(['next']), controller.signal)).rejects.toMatchObject({
    name: 'AbortError'
  })
})
