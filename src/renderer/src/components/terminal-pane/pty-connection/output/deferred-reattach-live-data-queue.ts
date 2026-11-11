import type { PtyDataMeta } from '../../pty-transport/delivery/pty-dispatcher'
import { flattenRetainedSlice } from '../../../../lib/flatten-retained-slice'
import {
  keptSuffixMeta,
  markedAfterEviction
} from '../../pty-transport/delivery/terminal-stream-position'

export const MAX_DEFERRED_REATTACH_LIVE_CHARS = 512 * 1024
export const MAX_DEFERRED_REATTACH_LIVE_CHUNKS = 1_024

const COMPACTION_MIN_HEAD = 64

export type DeferredReattachLiveDataChunk = {
  data: string
  ptyId: string | null
  streamGeneration: number
  meta?: PtyDataMeta
  ackCredit?: () => void
}

export class DeferredReattachLiveDataQueue {
  private chunks: (DeferredReattachLiveDataChunk | undefined)[] = []
  private head = 0
  private retainedChars = 0
  private streamGeneration: number | null = null

  enqueue(chunk: DeferredReattachLiveDataChunk): void {
    if (this.streamGeneration !== null && this.streamGeneration !== chunk.streamGeneration) {
      this.discard()
    }
    this.streamGeneration = chunk.streamGeneration

    const oversized = chunk.data.length > MAX_DEFERRED_REATTACH_LIVE_CHARS
    const queuedChunk = oversized
      ? {
          ...chunk,
          data: flattenRetainedSlice(chunk.data.slice(-MAX_DEFERRED_REATTACH_LIVE_CHARS)),
          meta: keptSuffixMeta(chunk.meta, chunk.data.length, MAX_DEFERRED_REATTACH_LIVE_CHARS)
        }
      : chunk
    this.chunks.push(queuedChunk)
    this.retainedChars += queuedChunk.data.length

    let dropped = oversized
    while (
      this.retainedChunkCount > 1 &&
      (this.retainedChunkCount > MAX_DEFERRED_REATTACH_LIVE_CHUNKS ||
        this.retainedChars > MAX_DEFERRED_REATTACH_LIVE_CHARS)
    ) {
      const removed = this.chunks[this.head]
      this.chunks[this.head] = undefined
      this.head += 1
      if (removed) {
        this.retainedChars -= removed.data.length
        removed.ackCredit?.()
      }
      dropped = true
    }

    const oldest = this.chunks[this.head]
    if (dropped && oldest) {
      // App bytes after a gap start at an unknown parser boundary.
      oldest.meta = markedAfterEviction(oldest.meta)
    }
    this.compact()
  }

  takeAll(): DeferredReattachLiveDataChunk[] {
    const retained: DeferredReattachLiveDataChunk[] = []
    for (let index = this.head; index < this.chunks.length; index += 1) {
      const chunk = this.chunks[index]
      if (chunk) {
        retained.push(chunk)
      }
    }
    this.reset()
    return retained
  }

  discard(): void {
    for (const chunk of this.takeAll()) {
      chunk.ackCredit?.()
    }
  }

  private get retainedChunkCount(): number {
    return this.chunks.length - this.head
  }

  private compact(): void {
    if (this.head < COMPACTION_MIN_HEAD || this.head * 2 < this.chunks.length) {
      return
    }
    this.chunks = this.chunks.slice(this.head)
    this.head = 0
  }

  private reset(): void {
    this.chunks = []
    this.head = 0
    this.retainedChars = 0
    this.streamGeneration = null
  }
}
