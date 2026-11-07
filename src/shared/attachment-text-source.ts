import * as z from 'zod'
import { attachmentTextSegments } from './attachment-text-segments'
export { attachmentTextSegments } from './attachment-text-segments'
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
const SEAM_BYTES = 1024
export const ATTACHMENT_TEXT_BLOCK_BYTES = 15 * 1024 - 8
export type AttachmentTextWindow = {
  block: number
  row: number
  rows: number
  fraction?: number
  tail?: boolean
}
export const ATTACHMENT_TEXT_COPY_MAX_BYTES = 16 * 1024 * 1024

export function attachmentTextBytes(contentBase64: string): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(contentBase64)) {
    throw new Error('Unreadable attachment reply. Try again.')
  }
  return Uint8Array.from(atob(contentBase64), (char) => char.charCodeAt(0))
}

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
    this.rowWidths.clear()
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
    let segments = this.blocks.get(index) ?? (this.rowCounts.get(index) === 0 ? [] : undefined)
    if (!segments) {
      const offset = index * ATTACHMENT_TEXT_BLOCK_BYTES
      const start = Math.max(0, offset - 3)
      const { bytes, eof } = await this.chunk(start, ATTACHMENT_TEXT_BLOCK_BYTES + SEAM_BYTES + 6)
      // Both neighbours derive seam ownership from the same bounded bytes, including CRLF/UTF-8 overlap.
      const boundary = (at: number) => {
        let aligned = Math.min(at, bytes.length)
        while (aligned < bytes.length && (bytes[aligned]! & 0xc0) === 0x80) {
          aligned++
        }
        if (!at || bytes[at - 1] === 10 || (bytes[at - 1] === 13 && bytes[at] !== 10)) {
          return aligned
        }
        const limit = Math.min(bytes.length, at + SEAM_BYTES)
        for (let end = aligned; end < limit; end++) {
          if (bytes[end] === 10) {
            return end + 1
          }
          if (bytes[end] === 13) {
            return end + (bytes[end + 1] === 10 ? 2 : 1)
          }
        }
        return eof && bytes.length <= at + SEAM_BYTES ? bytes.length : aligned
      }
      const from = boundary(offset - start)
      const to = boundary(offset + ATTACHMENT_TEXT_BLOCK_BYTES - start)
      const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
        bytes.subarray(from, to)
      )
      if (text.includes('\0')) {
        throw new Error('This file cannot be previewed as text. Save it to open it in another app.')
      }
      segments = text
        ? attachmentTextSegments(text.replace(/\r\n?/g, '\n'))
        : this.size === 0
          ? ['']
          : []
      this.blocks.set(index, segments)
    }
    this.rowCounts.set(index, segments.length)
    this.rowWidths.set(
      index,
      Math.max(
        0,
        ...segments.map((row) =>
          Array.from(row).reduce(
            (units, character) =>
              units +
              (character === '\n'
                ? 0
                : character === '\t'
                  ? 8
                  : character.codePointAt(0)! > 127
                    ? 2
                    : 1),
            0
          )
        )
      )
    )
    const keep = this.demand ? this.windowBlocks(this.demand.window) : [index]
    for (const key of this.blocks.keys()) {
      if (!keep.includes(key)) {
        this.blocks.delete(key)
      }
    }
    return segments
  }

  private readonly rowCounts = new Map<number, number>()
  private readonly rowWidths = new Map<number, number>()
  get displayUnits(): number {
    return Math.max(0, ...this.rowWidths.values())
  }
  private demand: { window: AttachmentTextWindow; publish: (error?: unknown) => void } | null = null
  private reading = false

  cachedBlock(index: number): readonly string[] | undefined {
    return this.blocks.get(index) ?? (this.rowCounts.get(index) === 0 ? [] : undefined)
  }
  rowCount(index: number): number {
    return this.rowCounts.get(index) ?? Math.ceil(ATTACHMENT_TEXT_BLOCK_BYTES / 256)
  }

  rowKnown(index: number): boolean {
    return this.rowCounts.has(index)
  }
  private windowBlocks(window: AttachmentTextWindow): number[] {
    const indices: number[] = []
    let remaining = window.rows
    let index = window.tail ? this.blockCount - 1 : window.block
    while (index >= 0 && index < this.blockCount && remaining > 0) {
      const count = this.rowCount(index)
      const first =
        index === window.block && !window.tail
          ? Math.floor(window.fraction === undefined ? window.row : window.fraction * count)
          : 0
      if (count) {
        indices.push(index)
      }
      remaining -= Math.max(0, count - first)
      index += window.tail ? -1 : 1
    }
    return indices
  }

  // Each successful bounded read advances the latest visible span; obsolete pending work is replaced.
  requestViewport(window: AttachmentTextWindow, publish: (error?: unknown) => void): void {
    this.demand = { window, publish }
    const keep = this.windowBlocks(window)
    for (const key of this.blocks.keys()) {
      if (!keep.includes(key)) {
        this.blocks.delete(key)
      }
    }
    if (!this.reading) {
      void this.drainViewport()
    }
  }
  private async drainViewport(): Promise<void> {
    this.reading = true
    let changed = false
    try {
      while (this.demand && !this.disposed) {
        const demand = this.demand
        try {
          const next = this.windowBlocks(demand.window).find((index) => !this.cachedBlock(index))
          if (next === undefined) {
            this.demand = null
            if (changed) {
              changed = false
              demand.publish()
            }
            continue
          }
          await this.block(next)
          changed = true
        } catch (error) {
          if (this.demand === demand && !this.disposed) {
            this.demand = null
            changed = false
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
