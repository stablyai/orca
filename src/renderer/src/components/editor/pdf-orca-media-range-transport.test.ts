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
  it('reads each range pdf.js asks for over IPC and hands back its bytes', async () => {
    const readPreviewRange = vi.fn(async () => new Uint8Array([7, 8, 9]))
    stubRangeReads(readPreviewRange)
    const transport = createOrcaMediaRangeTransport('orca-media://file/doc', 100, vi.fn())
    const onDataRange = vi.spyOn(transport, 'onDataRange')

    transport.requestDataRange(10, 13)

    await vi.waitFor(() => expect(onDataRange).toHaveBeenCalledWith(10, new Uint8Array([7, 8, 9])))
    expect(readPreviewRange).toHaveBeenCalledWith({
      url: 'orca-media://file/doc',
      offset: 10,
      length: 3
    })
  })

  it('reports a failed range instead of leaving pdf.js waiting', async () => {
    stubRangeReads(
      vi.fn(async () => {
        throw new Error('Preview is no longer available')
      })
    )
    const onFailure = vi.fn()
    createOrcaMediaRangeTransport('orca-media://file/doc', 100, onFailure).requestDataRange(0, 10)

    await vi.waitFor(() => expect(onFailure).toHaveBeenCalledOnce())
  })

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
