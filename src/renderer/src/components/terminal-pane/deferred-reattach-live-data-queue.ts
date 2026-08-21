import type { PtyDataMeta } from './pty-dispatcher'

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

export type DeferredReattachLiveDataQueueStorage = {
  backingLength: number
  head: number
  retainedChars: number
  retainedChunks: number
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
    const queuedChunk = {
      ...chunk,
      data: oversized ? chunk.data.slice(-MAX_DEFERRED_REATTACH_LIVE_CHARS) : chunk.data
    }
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
      oldest.meta = { ...oldest.meta, droppedOutput: true }
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

  getStorageForTest(): DeferredReattachLiveDataQueueStorage {
    return {
      backingLength: this.chunks.length,
      head: this.head,
      retainedChars: this.retainedChars,
      retainedChunks: this.retainedChunkCount
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
