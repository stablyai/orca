// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type PdfOptions = Record<string, unknown> & {
  range?: { requestDataRange: (begin: number, end: number) => void }
}

const { getDocument } = vi.hoisted(() => ({
  getDocument: vi.fn((_options: PdfOptions) => ({
    promise: new Promise(() => {}),
    destroy: vi.fn(async () => {})
  }))
}))
vi.mock('pdfjs-dist', () => ({
  getDocument,
  PDFDataRangeTransport: class {
    constructor(readonly length: number) {}
    onDataRange(): void {}
  }
}))

import { createPdfDocumentLoader } from './pdf-document-loader'

describe('PDF document loader sources', () => {
  beforeEach(() => {
    getDocument.mockClear()
  })

  it('reads a sized URL by range, and still decodes base64 for diffs and the web client', () => {
    const loader = createPdfDocumentLoader({ display: () => () => {}, onError: vi.fn() })
    loader.load({ url: 'orca-media://file/doc?revision=r2', length: 4096 })
    expect(getDocument.mock.lastCall?.[0]).toMatchObject({ range: { length: 4096 } })
    expect(getDocument.mock.lastCall?.[0]).not.toHaveProperty('url')

    getDocument.mockClear()
    const onError = vi.fn()
    const unsized = createPdfDocumentLoader({ display: () => () => {}, onError })
    unsized.load({ url: 'orca-media://file/empty?revision=r3' })
    expect(getDocument).not.toHaveBeenCalled()
    expect(onError).toHaveBeenLastCalledWith('Failed to load PDF preview')

    loader.load({ base64: 'JVBERg==' })
    expect(getDocument.mock.lastCall?.[0]).toMatchObject({
      data: new Uint8Array([0x25, 0x50, 0x44, 0x46])
    })
    loader.dispose()
  })

  afterEach(() => vi.unstubAllGlobals())

  it('tears down the load whose range failed, not just its message', async () => {
    vi.stubGlobal('window', {
      ...window,
      api: {
        fs: {
          readPreviewRange: vi.fn(async () => {
            throw new Error('gone')
          })
        }
      }
    })
    const onError = vi.fn()
    const loader = createPdfDocumentLoader({ display: () => () => {}, onError })
    loader.load({ url: 'orca-media://file/doc?revision=r1', length: 4096 })
    const task = getDocument.mock.results.at(-1)?.value

    getDocument.mock.lastCall?.[0].range?.requestDataRange(0, 1024)

    await vi.waitFor(() => expect(onError).toHaveBeenLastCalledWith('Failed to load PDF preview'))
    expect(task?.destroy).toHaveBeenCalledOnce()
    loader.dispose()
  })
})
