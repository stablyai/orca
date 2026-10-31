import { z } from 'zod'
import { waitForPromiseWithSignal } from './abort-signal-reason'
import { AGENT_SESSION_ATTACHMENT_MAX_BYTES } from './agent-session-attachments'
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
export const ATTACHMENT_TEXT_PAGE_BYTES = 16 * 1024 - 8
export const ATTACHMENT_TEXT_COPY_MAX_BYTES = 16 * 1024 * 1024
const SUBPAGE_SEGMENTS = 256

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

/** A preview owns one snapshot, two byte pages and a serial read queue; exports never populate the page cache. */
export class AttachmentTextSource {
  size: number | null = null
  snapshot: string | undefined
  private readonly abort = new AbortController()
  private tail: Promise<unknown> = Promise.resolve()
  private readonly pages = new Map<number, string[]>()

  constructor(
    readonly path: string,
    private readonly read: AttachmentTextRead
  ) {}

  dispose(): void {
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

  get pageCount(): number {
    return Math.max(1, Math.ceil((this.size ?? 0) / ATTACHMENT_TEXT_PAGE_BYTES))
  }

  async page(page: number, subpage = 0) {
    this.assertCurrent()
    let segments = this.pages.get(page)
    if (!segments) {
      const offset = page * ATTACHMENT_TEXT_PAGE_BYTES
      const start = Math.max(0, offset - 3)
      const { bytes, eof } = await this.chunk(start, ATTACHMENT_TEXT_PAGE_BYTES + (offset ? 6 : 3))
      let from = offset - start
      while (from < bytes.length && (bytes[from]! & 0xc0) === 0x80) {
        from++
      }
      let to = Math.min(bytes.length, offset + ATTACHMENT_TEXT_PAGE_BYTES - start)
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
      segments = attachmentTextSegments(text)
      this.pages.set(page, segments)
      while (this.pages.size > 2) {
        this.pages.delete(this.pages.keys().next().value!)
      }
    }
    const subpages = Math.max(1, Math.ceil(segments.length / SUBPAGE_SEGMENTS))
    const selected = Math.min(subpage, subpages - 1)
    return {
      page,
      subpage: selected,
      subpages,
      segments: segments.slice(selected * SUBPAGE_SEGMENTS, (selected + 1) * SUBPAGE_SEGMENTS)
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
