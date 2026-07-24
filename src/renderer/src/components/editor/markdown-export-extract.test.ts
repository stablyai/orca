// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getActiveMarkdownExportPayload, inlineBlobImageSources } from './markdown-export-extract'

vi.mock('@/store', () => ({
  useAppStore: {
    getState: vi.fn()
  }
}))

describe('getActiveMarkdownExportPayload', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } })
        )
    )
    const { useAppStore } = await import('@/store')
    vi.mocked(useAppStore.getState).mockReturnValue({
      openFiles: [
        {
          id: '/repo/docs/readme.md',
          filePath: '/repo/docs/readme.md',
          relativePath: 'docs/readme.md',
          mode: 'edit'
        }
      ]
    } as never)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('embeds blob image sources so the PDF export window can render local images', async () => {
    const root = document.createElement('div')
    root.innerHTML =
      '<div class="ProseMirror"><p><img src="blob:rich-local-image" alt="diagram"></p></div>'

    const payload = await getActiveMarkdownExportPayload({
      fileId: '/repo/docs/readme.md',
      root
    })

    expect(fetch).toHaveBeenCalledWith('blob:rich-local-image')
    expect(payload?.html).toContain('src="data:image/png;base64,AQID"')
    expect(payload?.html).not.toContain('blob:rich-local-image')
  })

  it('fails extraction when a blob image cannot be inlined', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false
    } as Response)
    const root = document.createElement('div')
    root.innerHTML =
      '<div class="ProseMirror"><p><img src="blob:missing-local-image" alt="diagram"></p></div>'

    await expect(
      getActiveMarkdownExportPayload({
        fileId: '/repo/docs/readme.md',
        root
      })
    ).rejects.toThrow('Failed to inline image for PDF export')
  })

  it('rejects streamed image bytes before the rendered fragment can exceed its cap', async () => {
    let cancelled = false
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(12))
            controller.enqueue(new Uint8Array(12))
          },
          cancel() {
            cancelled = true
          }
        }),
        { headers: { 'content-type': 'image/png' } }
      )
    )
    const root = document.createElement('div')
    root.innerHTML = '<img src="blob:large">'
    const prefixOnly = '<img src="data:image/png;base64,">'.length

    await expect(inlineBlobImageSources(root, prefixOnly + 16)).rejects.toThrow(
      'HTML export exceeds the PDF memory limit'
    )
    expect(cancelled).toBe(true)
  })
})
