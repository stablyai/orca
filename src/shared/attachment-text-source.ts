import { z } from 'zod'
import { waitForPromiseWithSignal } from './abort-signal-reason'
import { AGENT_SESSION_ATTACHMENT_MAX_BYTES } from './agent-session/agent-session-attachments'
import { MAX_FILE_RANGE_READ_BYTES, validateFileRangeRequest } from './file-range-read'

export type AttachmentTextRequest = {
  path: string
  offset: number
  length: number
  expectedSnapshot?: string
}
export const attachmentTextChunkSchema = z.object({
  snapshot: z.string().regex(/^[a-f0-9]{64}$/),
  size: z.number().int().nonnegative().max(AGENT_SESSION_ATTACHMENT_MAX_BYTES),
  contentBase64: z.string().max(Math.ceil(MAX_FILE_RANGE_READ_BYTES / 3) * 4),
  bytesRead: z.number().int().nonnegative().max(MAX_FILE_RANGE_READ_BYTES),
  eof: z.boolean()
})
export type AttachmentTextChunk = z.infer<typeof attachmentTextChunkSchema>
export type AttachmentTextRead = ((
  request: AttachmentTextRequest,
  signal?: AbortSignal
) => Promise<unknown>) & {
  assertCurrent?: () => void
}
export const ATTACHMENT_TEXT_BLOCK_BYTES = 16 * 1024 - 8
export const ATTACHMENT_TEXT_COPY_MAX_BYTES = 16 * 1024 * 1024

export function attachmentTextBytes(contentBase64: string): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(contentBase64)) {
    throw new Error('Unreadable attachment reply. Try again.')
  }
  return Uint8Array.from(atob(contentBase64), (char) => char.charCodeAt(0))
}

export function attachmentTextSegments(text: string): string[] {
  const segments: string[] = []
  let line = ''
  let columns = 0
  for (const character of text) {
    line += character
    columns++
    if (character === '\n' || columns === 256) {
      segments.push(line)
      line = ''
      columns = 0
    }
  }
  if (line || !segments.length) {
    segments.push(line)
  }
  return segments
}

/** A preview owns one snapshot, two byte blocks and a serial read queue; exports never populate the block cache. */
export class AttachmentTextSource {
  size: number | null = null
  snapshot: string | undefined
  private readonly abort = new AbortController()
  private tail: Promise<unknown> = Promise.resolve()
  private readonly blocks = new Map<number, string[]>()

  constructor(
    readonly path: string,
    private readonly read: AttachmentTextRead
  ) {}

  dispose(): void {
    this.demand = null
    this.blocks.clear()
    this.rowCounts.clear()
    this.abort.abort()
  }
  get disposed(): boolean {
    return this.abort.signal.aborted
  }
  assertCurrent(): void {
    this.abort.signal.throwIfAborted()
    this.read.assertCurrent?.()
  }

  async chunk(offset: number, length: number): Promise<{ bytes: Uint8Array; eof: boolean }> {
    validateFileRangeRequest(offset, length)
    const previous = this.tail
    const operation = (async () => {
      await waitForPromiseWithSignal(
        previous.catch(() => {}),
        this.abort.signal
      )
      this.assertCurrent()
      const parsed = attachmentTextChunkSchema.safeParse(
        await this.read(
          {
            path: this.path,
            offset,
            length,
            ...(this.snapshot ? { expectedSnapshot: this.snapshot } : {})
          },
          this.abort.signal
        )
      )
      this.assertCurrent()
      if (!parsed.success) {
        throw new Error('Unreadable attachment reply. Try again.')
      }
      const reply = parsed.data
      const bytes = attachmentTextBytes(reply.contentBase64)
      if (
        bytes.length !== reply.bytesRead ||
        bytes.length !== Math.min(length, reply.size - offset) ||
        offset + bytes.length > reply.size ||
        reply.eof !== (offset + bytes.length === reply.size) ||
        (!bytes.length && !reply.eof) ||
        (this.snapshot !== undefined &&
          (this.snapshot !== reply.snapshot || this.size !== reply.size))
      ) {
        throw new Error('Attachment changed or its reply was incomplete. Close it and try again.')
      }
      this.snapshot = reply.snapshot
      this.size = reply.size
      return { bytes, eof: reply.eof }
    })()
    this.tail = operation
    return operation
  }

  get blockCount(): number {
    return Math.max(1, Math.ceil((this.size ?? 0) / ATTACHMENT_TEXT_BLOCK_BYTES))
  }

  async block(index: number) {
    this.assertCurrent()
    let segments = this.blocks.get(index)
    if (!segments) {
      const offset = index * ATTACHMENT_TEXT_BLOCK_BYTES
      const start = Math.max(0, offset - 3)
      const { bytes, eof } = await this.chunk(start, ATTACHMENT_TEXT_BLOCK_BYTES + (offset ? 6 : 3))
      let from = offset - start
      while (from < bytes.length && (bytes[from]! & 0xc0) === 0x80) {
        from++
      }
      let to = Math.min(bytes.length, offset + ATTACHMENT_TEXT_BLOCK_BYTES - start)
      if (!eof || to < bytes.length) {
        while (to < bytes.length && (bytes[to]! & 0xc0) === 0x80) {
          to++
        }
      }
      const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
        bytes.subarray(from, to)
      )
      if (text.includes('\0')) {
        throw new Error('This file cannot be previewed as text. Save it to open it in another app.')
      }
      // A CRLF split across byte blocks is one display break; exports retain the original bytes.
      const displayText = text.replace(/\r\n?/g, '\n')
      segments = attachmentTextSegments(
        from > 0 && bytes[from - 1] === 13 && text.startsWith('\n')
          ? displayText.slice(1)
          : displayText
      )
      this.blocks.set(index, segments)
      while (this.blocks.size > 2) {
        this.blocks.delete(this.blocks.keys().next().value!)
      }
    }
    this.blocks.delete(index)
    this.blocks.set(index, segments)
    this.rowCounts.set(index, segments.length)
    return segments
  }

  private readonly rowCounts = new Map<number, number>()
  private demand: { indices: number[]; publish: (error?: unknown) => void } | null = null
  private reading = false

  cachedBlock(index: number): readonly string[] | undefined {
    return this.blocks.get(index)
  }
  rowCount(index: number): number {
    return this.rowCounts.get(index) ?? 64
  }

  // Replace pending viewport work; only the already dispatched range may outlive a demand.
  requestViewport(indices: number[], publish: (error?: unknown) => void): void {
    this.demand = { indices: indices.slice(0, 2), publish }
    if (!this.reading) {
      void this.drainViewport()
    }
  }
  private async drainViewport(): Promise<void> {
    this.reading = true
    try {
      while (this.demand && !this.disposed) {
        const demand = this.demand
        try {
          for (const index of demand.indices) {
            if (this.demand !== demand) {
              break
            }
            await this.block(index)
          }
          if (this.demand === demand && !this.disposed) {
            this.demand = null
            demand.publish()
          }
        } catch (error) {
          if (this.demand === demand && !this.disposed) {
            this.demand = null
            demand.publish(error)
          }
        }
      }
    } finally {
      this.reading = false
    }
  }

  async *bytes(): AsyncGenerator<Uint8Array> {
    let offset = 0
    for (;;) {
      const chunk = await this.chunk(offset, MAX_FILE_RANGE_READ_BYTES)
      this.assertCurrent()
      yield chunk.bytes
      offset += chunk.bytes.length
      if (chunk.eof) {
        return
      }
    }
  }

  async copyText(): Promise<string> {
    if (this.size === null) {
      await this.chunk(0, 1)
    }
    if (this.size! > ATTACHMENT_TEXT_COPY_MAX_BYTES) {
      throw new Error('This file is too large to copy. Save it instead.')
    }
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
    const parts: string[] = []
    for await (const bytes of this.bytes()) {
      parts.push(decoder.decode(bytes, { stream: true }))
    }
    parts.push(decoder.decode())
    this.assertCurrent()
    return parts.join('')
  }
}
