export class RelayFrameBuffer {
  private chunks: (Buffer | undefined)[] = []
  private head = 0
  private bytes = 0

  get length(): number {
    return this.bytes
  }

  append(chunk: Buffer): void {
    this.chunks.push(chunk)
    this.bytes += chunk.length
  }

  clear(): void {
    this.chunks = []
    this.head = 0
    this.bytes = 0
  }

  drain(): Buffer {
    const out =
      this.chunks.length - this.head === 1
        ? this.chunks[this.head]!
        : Buffer.concat(this.chunks.slice(this.head) as Buffer[], this.bytes)
    this.clear()
    return out
  }

  peek(count: number): Buffer {
    const first = this.chunks[this.head]!
    if (first.length >= count) {
      return first
    }
    const out = Buffer.allocUnsafe(count)
    let copied = 0
    for (let index = this.head; index < this.chunks.length; index += 1) {
      const part = this.chunks[index]!
      copied += part.copy(out, copied, 0, Math.min(part.length, count - copied))
      if (copied >= count) {
        break
      }
    }
    return out
  }

  take(count: number): Buffer {
    const first = this.chunks[this.head]!
    if (first.length === count) {
      this.removeHead()
      this.bytes -= count
      return first
    }
    if (first.length > count) {
      this.chunks[this.head] = first.subarray(count)
      this.bytes -= count
      return first.subarray(0, count)
    }
    const out = Buffer.allocUnsafe(count)
    let copied = 0
    while (copied < count) {
      const part = this.chunks[this.head]!
      const take = Math.min(part.length, count - copied)
      part.copy(out, copied, 0, take)
      copied += take
      if (take === part.length) {
        this.removeHead()
      } else {
        this.chunks[this.head] = part.subarray(take)
      }
    }
    this.bytes -= count
    return out
  }

  private removeHead(): void {
    this.chunks[this.head] = undefined
    this.head += 1
    // Amortize compaction without retaining consumed buffers.
    if (
      this.head === this.chunks.length ||
      (this.head >= 1024 && this.head * 2 >= this.chunks.length)
    ) {
      this.chunks = this.chunks.slice(this.head)
      this.head = 0
    }
  }

  discard(count: number): void {
    let remaining = count
    while (remaining > 0) {
      const part = this.chunks[this.head]!
      if (part.length <= remaining) {
        this.removeHead()
        remaining -= part.length
      } else {
        this.chunks[this.head] = part.subarray(remaining)
        remaining = 0
      }
    }
    this.bytes -= count
  }
}
