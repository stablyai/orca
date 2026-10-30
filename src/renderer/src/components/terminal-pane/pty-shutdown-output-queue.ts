import { TERMINAL_SCROLLBACK_SESSION_BUFFER_BYTE_LIMIT } from '../../../../shared/terminal-scrollback-limits'
import { clampUtf8Tail } from './pty-eager-buffer-clamp'
import type { PtyDataMeta } from './pty-dispatcher'

const EVENT_CHUNK_SIZE = 64
const COMPACTION_MIN_HEAD_CHUNKS = 64

export type PtyShutdownOutputEvent =
  | { kind: 'data'; data: string; meta?: PtyDataMeta }
  | { kind: 'replay'; data: string }

type PtyShutdownOutputChunk = {
  events: (PtyShutdownOutputEvent | undefined)[]
  eventBytes?: Uint32Array
}

export type PtyShutdownOutputQueueStorage = {
  backingLength: number
  byteBackingLength: number
  chunkBackingLength: number
  head: number
  headChunk: number
  retainedBytes: number
  retainedEvents: number
}

export class PtyShutdownOutputQueue {
  private chunks: (PtyShutdownOutputChunk | undefined)[] = []
  private headChunk = 0
  private headOffset = 0
  private retainedBytes = 0
  private retainedEvents = 0

  enqueue(event: PtyShutdownOutputEvent): void {
    const clamped = clampUtf8Tail(event.data, TERMINAL_SCROLLBACK_SESSION_BUFFER_BYTE_LIMIT)
    let tail = this.chunks.at(-1)
    if (!tail || tail.events.length >= EVENT_CHUNK_SIZE) {
      tail = { events: [] }
      this.chunks.push(tail)
    }
    const tailOffset = tail.events.length
    tail.events.push({ ...event, data: clamped.data })
    if (clamped.bytes !== clamped.data.length) {
      tail.eventBytes ??= new Uint32Array(EVENT_CHUNK_SIZE)
      tail.eventBytes[tailOffset] = clamped.bytes
    }
    this.retainedBytes += clamped.bytes
    this.retainedEvents += 1

    while (this.length > 1 && this.retainedBytes > TERMINAL_SCROLLBACK_SESSION_BUFFER_BYTE_LIMIT) {
      this.evictOldest()
    }
  }

  takeAll(): PtyShutdownOutputEvent[] {
    const events: PtyShutdownOutputEvent[] = []
    this.drain((event) => events.push(event))
    return events
  }

  drain(consumer: (event: PtyShutdownOutputEvent) => void): void {
    const chunks = this.chunks
    const headChunk = this.headChunk
    const headOffset = this.headOffset
    this.reset()
    for (let chunkIndex = headChunk; chunkIndex < chunks.length; chunkIndex += 1) {
      const chunk = chunks[chunkIndex]
      if (!chunk) {
        continue
      }
      const start = chunkIndex === headChunk ? headOffset : 0
      for (let eventIndex = start; eventIndex < chunk.events.length; eventIndex += 1) {
        const event = chunk.events[eventIndex]
        if (event) {
          consumer(event)
        }
      }
    }
  }

  discard(): void {
    this.reset()
  }

  get length(): number {
    return this.retainedEvents
  }

  getStorageForTest(): PtyShutdownOutputQueueStorage {
    let backingLength = 0
    let byteBackingLength = 0
    for (const chunk of this.chunks) {
      if (chunk) {
        backingLength += chunk.events.length
        byteBackingLength += chunk.eventBytes?.length ?? 0
      }
    }
    return {
      backingLength,
      byteBackingLength,
      chunkBackingLength: this.chunks.length,
      head: this.headOffset,
      headChunk: this.headChunk,
      retainedBytes: this.retainedBytes,
      retainedEvents: this.length
    }
  }

  private evictOldest(): void {
    const chunk = this.chunks[this.headChunk]
    if (!chunk) {
      throw new Error('Missing PTY shutdown output queue chunk')
    }
    const event = chunk.events[this.headOffset]
    if (!event) {
      throw new Error('Missing PTY shutdown output queue event')
    }
    this.retainedBytes -= chunk.eventBytes?.[this.headOffset] || event.data.length
    chunk.events[this.headOffset] = undefined
    if (chunk.eventBytes) {
      chunk.eventBytes[this.headOffset] = 0
    }
    this.headOffset += 1
    this.retainedEvents -= 1
    if (this.headOffset < chunk.events.length) {
      return
    }
    this.chunks[this.headChunk] = undefined
    this.headChunk += 1
    this.headOffset = 0
    this.compactChunks()
  }

  private compactChunks(): void {
    if (this.headChunk < COMPACTION_MIN_HEAD_CHUNKS || this.headChunk * 2 < this.chunks.length) {
      return
    }
    this.chunks = this.chunks.slice(this.headChunk)
    this.headChunk = 0
  }

  private reset(): void {
    this.chunks = []
    this.headChunk = 0
    this.headOffset = 0
    this.retainedBytes = 0
    this.retainedEvents = 0
  }
}
