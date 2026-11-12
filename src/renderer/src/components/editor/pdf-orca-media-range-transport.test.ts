// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('pdfjs-dist', () => ({
  PDFDataRangeTransport: class {
    constructor(
      readonly length: number,
      readonly initialData: unknown
    ) {}
    onDataRange(_begin: number, _chunk: Uint8Array): void {}
  }
}))

import { createOrcaMediaRangeTransport } from './pdf-orca-media-range-transport'

afterEach(() => vi.unstubAllGlobals())

function stubRangeReads(
  readPreviewRange: (args: { url: string; offset: number; length: number }) => Promise<Uint8Array>
) {
  vi.stubGlobal('window', { ...window, api: { fs: { readPreviewRange } } })
}

describe('orca-media range transport for pdf.js', () => {
  it('stops reading the rest of a merged range once the viewer aborts', async () => {
    let release: (bytes: Uint8Array) => void = () => {}
    const readPreviewRange = vi.fn(() => new Promise<Uint8Array>((resolve) => (release = resolve)))
    stubRangeReads(readPreviewRange)
    const transport = createOrcaMediaRangeTransport('orca-media://file/doc', 12 << 20, vi.fn())

    transport.requestDataRange(0, 12 << 20)
    await vi.waitFor(() => expect(readPreviewRange).toHaveBeenCalledOnce())
    transport.abort()
    release(new Uint8Array(4 << 20))
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(readPreviewRange).toHaveBeenCalledOnce()
  })
})
