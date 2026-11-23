// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { captureImageSource, imageDownloadName, readImageFileSource } from './image-source-actions'

afterEach(() => vi.unstubAllGlobals())

describe('image source actions', () => {
  it.each([
    {
      size: '32769 x 1',
      content: 'iVBORw0KGgoAAAANSUhEUgAAgAEAAAAB',
      hex: '89504e470d0a1a0a0000000d494844520000800100000001'
    },
    {
      size: '8192 x 8192',
      content: 'iVBORw0KGgoAAAANSUhEUgAAIAAAACAA',
      hex: '89504e470d0a1a0a0000000d494844520000200000002000'
    }
  ])('decodes original $size image bytes without preview limits', async ({ content, hex }) => {
    vi.stubGlobal('api', {
      fs: {
        readFile: async () => ({
          content: `${content.slice(0, 8)}\n${content.slice(8)}`,
          isBinary: true,
          mimeType: 'image/png'
        })
      }
    })
    const blob = await readImageFileSource({
      target: { kind: 'local' },
      filePath: '/large.png'
    })()
    expect(Buffer.from(await blob.arrayBuffer()).toString('hex')).toBe(hex)
  })

  it.each([
    { content: btoa('web page'), mimeType: 'text/html' },
    { content: btoa('document'), mimeType: 'application/pdf' },
    { content: ' \n\t', mimeType: 'image/png' },
    { content: 'not%base64', mimeType: 'image/png' }
  ])('refuses an unusable image payload with MIME $mimeType', async (result) => {
    const readFile = vi.fn().mockResolvedValue({ ...result, isBinary: true })
    vi.stubGlobal('api', { fs: { readFile } })
    await expect(
      readImageFileSource({ target: { kind: 'local' }, filePath: '/image.png' })()
    ).rejects.toThrow()
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

  it('refuses HTML error pages as image content', async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      blob: async () => new Blob(['login'], { type: 'text/html' })
    })
    vi.stubGlobal('fetch', fetch)
    const read = captureImageSource('https://example.com/image.png')
    await expect(read()).rejects.toThrow('web page')
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
