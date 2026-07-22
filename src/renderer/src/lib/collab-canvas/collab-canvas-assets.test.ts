import { describe, expect, it } from 'vitest'
import {
  CollabCanvasAssetTooLargeError,
  MAX_INLINE_ASSET_BYTES,
  createInlineAssetStore
} from './collab-canvas-assets'

function fileOf(bytes: number, type = 'image/png'): File {
  return new File([new Uint8Array(bytes)], 'a.png', { type })
}

describe('createInlineAssetStore', () => {
  it('inlines a small asset as a data URI so sync carries it to every device', async () => {
    const store = createInlineAssetStore()
    const result = await store.upload({} as never, fileOf(8))
    expect(result.src).toMatch(/^data:image\/png;base64,/)
  })

  it('round-trips the bytes rather than truncating them', async () => {
    const store = createInlineAssetStore()
    const file = new File([new Uint8Array([1, 2, 3, 250, 251])], 'a.bin', {
      type: 'application/octet-stream'
    })
    const { src } = await store.upload({} as never, file)
    const base64 = src!.split(',')[1]
    const decoded = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
    expect([...decoded]).toEqual([1, 2, 3, 250, 251])
  })

  it('handles an asset larger than one fromCharCode chunk', async () => {
    // The encoder chunks at 0x8000; a single spread over this would throw.
    const store = createInlineAssetStore()
    const result = await store.upload({} as never, fileOf(0x8000 * 2 + 5))
    expect(result.src).toMatch(/^data:/)
  })

  it('falls back to a generic media type when the file has none', async () => {
    const store = createInlineAssetStore()
    const result = await store.upload({} as never, fileOf(4, ''))
    expect(result.src).toMatch(/^data:application\/octet-stream;base64,/)
  })

  it('refuses an oversized asset loudly instead of bloating every client', async () => {
    const store = createInlineAssetStore(64)
    await expect(store.upload({} as never, fileOf(65))).rejects.toBeInstanceOf(
      CollabCanvasAssetTooLargeError
    )
  })

  it('defaults the cap to the documented limit', async () => {
    const store = createInlineAssetStore()
    await expect(
      store.upload({} as never, fileOf(MAX_INLINE_ASSET_BYTES + 1))
    ).rejects.toBeInstanceOf(CollabCanvasAssetTooLargeError)
  })

  it('resolves an asset to its inlined src', () => {
    const store = createInlineAssetStore()
    expect(store.resolve!({ props: { src: 'data:image/png;base64,AAA' } } as never, {} as never)).toBe(
      'data:image/png;base64,AAA'
    )
  })
})
