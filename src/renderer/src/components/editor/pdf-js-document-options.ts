import type { PDFDataRangeTransport } from 'pdfjs-dist'
import { MAX_FILE_RANGE_READ_BYTES } from '../../../../shared/file-range-read'

export function buildPdfJsDocumentOptions(
  source: { data: Uint8Array } | { range: PDFDataRangeTransport },
  baseUrl: string
) {
  return {
    ...source,
    // One readChunk-sized range per request instead of pdf.js's 64 KiB default.
    ...('range' in source ? { rangeChunkSize: MAX_FILE_RANGE_READ_BYTES } : {}),
    cMapUrl: new URL('cmaps/', baseUrl).href,
    cMapPacked: true,
    standardFontDataUrl: new URL('standard_fonts/', baseUrl).href,
    wasmUrl: new URL('wasm/', baseUrl).href
  }
}
