// LSP stdio framing: `Content-Length: N\r\n\r\n<json>`. Hand-written per the
// editor-navigation spec (D2): no monaco-languageclient, only this plus the
// JSON-RPC client. Buffer discipline from the spike findings §6 — all
// buffering stays at the byte level so multi-byte UTF-8 never splits.

const HEADER_TERMINATOR = Buffer.from('\r\n\r\n', 'ascii')
// clangd on Windows emits \r\n\r\n, but the header terminator is accepted in
// both spellings defensively (cost is one indexOf).
const HEADER_TERMINATOR_LF = Buffer.from('\n\n', 'ascii')
const MAX_HEADER_BYTES = 1 << 20

/** JSON-RPC message -> wire bytes. */
export function encodeLspMessage(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii')
  return Buffer.concat([header, body])
}

function parseContentLength(headerBlock: Buffer): number {
  let contentLength = -1
  for (const rawLine of headerBlock.toString('ascii').split(/\r?\n/)) {
    const index = rawLine.indexOf(':')
    if (index === -1) {
      continue
    }
    const name = rawLine.slice(0, index).trim().toLowerCase()
    if (name !== 'content-length') {
      continue
    }
    contentLength = Number(rawLine.slice(index + 1).trim())
  }
  return contentLength
}

export type LspFrameParser = {
  /** Feed one stdout chunk; complete frames call onMessage synchronously. */
  feed(chunk: Buffer): void
  /** Diagnostics: frames parsed so far and bytes waiting for completion. */
  stats(): { frames: number; pendingBytes: number }
}

/**
 * Incremental frame parser. Sticky and split packets both work: feed() loops
 * until the buffer cannot yield another complete frame and keeps the remainder.
 * A frame that cannot be parsed is fatal-by-policy — the caller kills the
 * session rather than attempting to resynchronize (spike findings §6, rule 3).
 */
export function createLspFrameParser(
  onMessage: (message: unknown) => void,
  onError: (error: Error) => void
): LspFrameParser {
  let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0)
  let frames = 0

  const findTerminator = (): { index: number; length: number } => {
    const crlf = buffer.indexOf(HEADER_TERMINATOR)
    const lf = buffer.indexOf(HEADER_TERMINATOR_LF)
    if (crlf === -1) {
      return { index: lf, length: 2 }
    }
    if (lf === -1 || crlf <= lf) {
      return { index: crlf, length: 4 }
    }
    return { index: lf, length: 2 }
  }

  const discard = (error: Error): void => {
    onError(error)
    buffer = Buffer.alloc(0)
  }

  return {
    feed(chunk: Buffer): void {
      buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk])
      for (;;) {
        if (buffer.length === 0) {
          return
        }
        const { index, length } = findTerminator()
        if (index === -1) {
          if (buffer.length > MAX_HEADER_BYTES) {
            discard(
              new Error(`LSP header block exceeded ${MAX_HEADER_BYTES} bytes without a terminator`)
            )
          }
          return
        }
        const contentLength = parseContentLength(buffer.subarray(0, index))
        if (!Number.isInteger(contentLength) || contentLength < 0) {
          discard(
            new Error(
              `LSP frame without valid Content-Length (got ${contentLength}); dropping ${buffer.length} bytes`
            )
          )
          return
        }
        const bodyStart = index + length
        const total = bodyStart + contentLength
        if (buffer.length < total) {
          return
        }
        const body = buffer.subarray(bodyStart, total)
        buffer = buffer.subarray(total)
        frames += 1
        let parsed: unknown
        try {
          parsed = JSON.parse(body.toString('utf8'))
        } catch (error) {
          discard(
            new Error(
              `LSP frame #${frames} failed JSON.parse: ${
                error instanceof Error ? error.message : String(error)
              }`
            )
          )
          return
        }
        onMessage(parsed)
      }
    },
    stats(): { frames: number; pendingBytes: number } {
      return { frames, pendingBytes: buffer.length }
    }
  }
}
