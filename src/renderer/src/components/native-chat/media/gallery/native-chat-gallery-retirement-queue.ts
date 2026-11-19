export class NativeChatGalleryRetirementQueue {
  private chunks: (readonly number[])[] = []
  private head = 0
  private offset = 0

  clear(): void {
    this.chunks = []
    this.head = 0
    this.offset = 0
  }

  enqueue(handles: readonly number[]): void {
    if (handles.length) {
      this.chunks.push(handles)
    }
  }

  peek(): readonly number[] {
    return this.chunks[this.head]?.slice(this.offset, this.offset + 128) ?? []
  }

  acknowledge(length: number): void {
    const current = this.chunks[this.head]
    if (!current || length <= 0 || this.offset + length > current.length) {
      throw new Error('Gallery retirement acknowledgement is out of sequence')
    }
    this.offset += length
    if (this.offset === current.length) {
      this.chunks[this.head] = []
      this.head++
      this.offset = 0
      if (this.head === this.chunks.length) {
        this.clear()
      }
    }
  }
}
