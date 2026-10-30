// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { captureImageSource, imageDownloadName, saveImageSource } from './image-source-actions'

afterEach(() => vi.unstubAllGlobals())

describe('image source actions', () => {
  it('captures a revocable source before the menu can unmount it', async () => {
    const blob = new Blob(['original'], { type: 'image/webp' })
    const fetch = vi.fn().mockResolvedValue({ ok: true, blob: async () => blob })
    vi.stubGlobal('fetch', fetch)
    const read = captureImageSource('blob:original')
    expect(fetch).toHaveBeenCalledOnce()
    expect(await read()).toBe(blob)
  })

  it('fetches network images only when selected and refuses HTML error pages', async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      blob: async () => new Blob(['login'], { type: 'text/html' })
    })
    vi.stubGlobal('fetch', fetch)
    const read = captureImageSource('https://example.com/image.png')
    expect(fetch).not.toHaveBeenCalled()
    await expect(read()).rejects.toThrow('web page')
  })

  it('keeps the original encoding when saving to this computer', async () => {
    const saveDownloadedFile = vi
      .fn()
      .mockResolvedValue({ canceled: false, destinationPath: '/saved.webp' })
    vi.stubGlobal('api', { fs: { saveDownloadedFile } })
    await saveImageSource(
      async () => new Blob(['original'], { type: 'image/webp' }),
      'picture.webp'
    )
    expect(saveDownloadedFile).toHaveBeenCalledWith({
      suggestedName: 'picture.webp',
      content: btoa('original'),
      encoding: 'base64'
    })
  })

  it('uses a real filename or the image MIME type instead of a blob URL or alt text', () => {
    expect(imageDownloadName('blob:internal', 'A chart of sales', 'image/svg+xml')).toBe(
      'Image.svg'
    )
    expect(
      imageDownloadName('https://example.com/My%20Photo.jpg?token=hidden', 'Photo', 'image/jpeg')
    ).toBe('My Photo.jpg')
    expect(
      imageDownloadName('blob:internal', 'Photo', 'image/webp', 'C:\\shots\\original.webp')
    ).toBe('original.webp')
    expect(imageDownloadName('https://example.com/render.php', 'Chart', 'image/png')).toBe(
      'Image.png'
    )
  })
})
