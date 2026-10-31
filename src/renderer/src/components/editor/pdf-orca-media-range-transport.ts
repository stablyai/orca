import { PDFDataRangeTransport } from 'pdfjs-dist'

// Main's per-call bound for preview range reads; pdf.js may merge neighbouring chunks past it.
const PREVIEW_RANGE_READ_MAX_BYTES = 4 * 1024 * 1024

/**
 * pdf.js only fetches ranges over http(s); this reads an orca-media grant's ranges over IPC, which
 * main answers only for the renderer that minted it, so the scheme needs no fetch or CORS.
 */
export function createOrcaMediaRangeTransport(
  url: string,
  length: number,
  onFailure: (error: unknown) => void
): PDFDataRangeTransport {
  let aborted = false
  class OrcaMediaRangeTransport extends PDFDataRangeTransport {
    override requestDataRange(begin: number, end: number): void {
      void readRange(url, begin, end, () => aborted)
        .then((chunk) => {
          if (!aborted) {
            this.onDataRange(begin, chunk)
          }
        })
        .catch((error: unknown) => {
          // pdf.js has no range-failure callback; without this it would wait forever.
          if (!aborted) {
            onFailure(error)
          }
        })
    }

    override abort(): void {
      aborted = true
    }
  }
  return new OrcaMediaRangeTransport(length, null)
}

async function readRange(
  url: string,
  begin: number,
  end: number,
  isAborted: () => boolean
): Promise<Uint8Array> {
  const range = new Uint8Array(end - begin)
  let read = 0
  while (begin + read < end) {
    // A closed or reloaded viewer schedules no further pieces.
    if (isAborted()) {
      throw new Error('PDF range read cancelled')
    }
    const piece = await window.api.fs.readPreviewRange({
      url,
      offset: begin + read,
      length: Math.min(PREVIEW_RANGE_READ_MAX_BYTES, end - begin - read)
    })
    if (piece.byteLength === 0) {
      throw new Error('PDF ended before the requested range')
    }
    range.set(piece, read)
    read += piece.byteLength
  }
  return range
}
