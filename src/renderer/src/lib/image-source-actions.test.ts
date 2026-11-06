// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  captureImageSource,
  imageDownloadName,
  readImageFileSource,
  saveImageSource
} from './image-source-actions'

afterEach(() => vi.unstubAllGlobals())

describe('image source actions', () => {
  it.each([
    [32769, 1],
    [8192, 8192]
  ])(
    'saves original bytes with a %i x %i raster header without applying preview limits',
    async (width, height) => {
      const bytes = Buffer.alloc(24)
      bytes.set([137, 80, 78, 71, 13, 10, 26, 10])
      bytes.writeUInt32BE(13, 8)
      bytes.write('IHDR', 12, 'ascii')
      bytes.writeUInt32BE(width, 16)
      bytes.writeUInt32BE(height, 20)
      const content = bytes.toString('base64')
      const readFile = vi.fn().mockResolvedValue({
        content: `${content.slice(0, 8)}\n${content.slice(8)}`,
        isBinary: true,
        mimeType: 'image/png'
      })
      const saveDownloadedFile = vi
        .fn()
        .mockResolvedValue({ canceled: false, destinationPath: '/saved.png' })
      vi.stubGlobal('api', { fs: { readFile, saveDownloadedFile } })
      await saveImageSource(
        readImageFileSource({ target: { kind: 'local' }, filePath: '/large.png' }),
        'large.png'
      )
      expect(saveDownloadedFile).toHaveBeenCalledWith({
        suggestedName: 'large.png',
        content,
        encoding: 'base64'
      })
    }
  )

  it.each([
    { content: btoa('web page'), mimeType: 'text/html' },
    { content: btoa('document'), mimeType: 'application/pdf' },
    { content: ' \n\t', mimeType: 'image/png' },
    { content: 'not%base64', mimeType: 'image/png' }
  ])('refuses an unusable file payload with MIME $mimeType before saving', async (result) => {
    const readFile = vi.fn().mockResolvedValue({ ...result, isBinary: true })
    const saveDownloadedFile = vi.fn()
    vi.stubGlobal('api', { fs: { readFile, saveDownloadedFile } })
    await expect(
      saveImageSource(
        readImageFileSource({ target: { kind: 'local' }, filePath: '/image.png' }),
        'image.png'
      )
    ).rejects.toThrow()
    expect(saveDownloadedFile).not.toHaveBeenCalled()
  })

  it('keeps non-binary SVG markup as an SVG Blob', async () => {
    const markup = '<svg xmlns="http://www.w3.org/2000/svg"/>'
    const readFile = vi.fn().mockResolvedValue({ content: markup, isBinary: false })
    vi.stubGlobal('api', { fs: { readFile } })
    const blob = await readImageFileSource(
      { target: { kind: 'local' }, filePath: '/drawing.svg' },
      'image/svg+xml'
    )()
    expect(blob.type).toBe('image/svg+xml')
    expect(await blob.text()).toBe(markup)
  })

  it('reads original file bytes lazily through the existing owner route without range previews', async () => {
    const readFile = vi
      .fn()
      .mockResolvedValue({ content: btoa('original'), isBinary: true, mimeType: 'image/png' })
    vi.stubGlobal('api', { fs: { readFile } })
    const read = readImageFileSource({
      target: { kind: 'local' },
      filePath: '/image.png',
      pageOversizedBinary: true
    })
    expect(readFile).not.toHaveBeenCalled()
    const blob = await read()
    expect(await blob.text()).toBe('original')
    expect(readFile).toHaveBeenCalledWith({
      filePath: '/image.png',
      connectionId: undefined,
      includeLocalLogMetadata: undefined
    })
    expect(blob.type).toBe('image/png')
  })

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
