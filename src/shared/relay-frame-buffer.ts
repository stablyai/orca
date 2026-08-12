export class RelayFrameBuffer {
  private chunks: Buffer[] = []
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
    this.bytes = 0
  }

  drain(): Buffer {
    const out = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks, this.bytes)
    this.clear()
    return out
  }

  peek(count: number): Buffer {
    const first = this.chunks[0]
    if (first.length >= count) {
      return first
    }
    const out = Buffer.allocUnsafe(count)
    let copied = 0
    for (const part of this.chunks) {
      copied += part.copy(out, copied, 0, Math.min(part.length, count - copied))
      if (copied >= count) {
        break
      }
    }
    return out
  }

  take(count: number): Buffer {
    const first = this.chunks[0]
    if (first.length === count) {
      this.chunks.shift()
      this.bytes -= count
      return first
    }
    if (first.length > count) {
      this.chunks[0] = first.subarray(count)
      this.bytes -= count
      return first.subarray(0, count)
    }
    const out = Buffer.allocUnsafe(count)
    let copied = 0
    while (copied < count) {
      const part = this.chunks[0]
      const take = Math.min(part.length, count - copied)
      part.copy(out, copied, 0, take)
      copied += take
      if (take === part.length) {
        this.chunks.shift()
      } else {
        this.chunks[0] = part.subarray(take)
      }
    }
    this.bytes -= count
    return out
  }

  discard(count: number): void {
    let remaining = count
    while (remaining > 0) {
      const part = this.chunks[0]
      if (part.length <= remaining) {
        this.chunks.shift()
        remaining -= part.length
      } else {
        this.chunks[0] = part.subarray(remaining)
        remaining = 0
      }
    }
    this.bytes -= count
  }
}
