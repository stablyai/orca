export class GrowingByteBuffer {
  private storage = Buffer.alloc(0)
  // Live bytes are storage[start, start + length); the head offset keeps prefix discards O(1).
  private start = 0
  private length = 0

  get byteLength(): number {
    return this.length
  }

  append(bytes: Buffer | Uint8Array): void {
    if (bytes.byteLength === 0) {
      return
    }
    const required = this.length + bytes.byteLength
    if (this.start + required > this.storage.byteLength) {
      this.reclaimHeadRoom(required)
    }
    const source = Buffer.isBuffer(bytes)
      ? bytes
      : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    source.copy(this.storage, this.start + this.length)
    this.length = required
  }

  appendRetainedSuffix(bytes: Buffer | Uint8Array, maxBytes: number): void {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
      throw new RangeError('Retained suffix limit must be a non-negative safe integer')
    }
    if (maxBytes === 0) {
      this.clear()
      return
    }
    const source = Buffer.isBuffer(bytes)
      ? bytes
      : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    if (source.byteLength >= maxBytes) {
      this.storage = Buffer.from(source.subarray(source.byteLength - maxBytes))
      this.start = 0
      this.length = maxBytes
      return
    }
    this.retainSuffix(maxBytes - source.byteLength)
    this.append(source)
  }

  indexOfByte(value: number, byteOffset = 0): number {
    return this.storage.subarray(this.start, this.start + this.length).indexOf(value, byteOffset)
  }

  takePrefixString(byteLength: number, encoding: BufferEncoding = 'utf8'): string {
    if (!Number.isSafeInteger(byteLength) || byteLength < 0 || byteLength > this.length) {
      throw new RangeError('Prefix length exceeds retained bytes')
    }
    const value = this.storage.toString(encoding, this.start, this.start + byteLength)
    this.discardPrefix(byteLength)
    return value
  }

  discardPrefix(byteLength: number): void {
    if (!Number.isSafeInteger(byteLength) || byteLength < 0 || byteLength > this.length) {
      throw new RangeError('Prefix length exceeds retained bytes')
    }
    this.start += byteLength
    this.length -= byteLength
    if (this.length === 0) {
      this.start = 0
    }
  }

  retainSuffix(maxBytes: number): void {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
      throw new RangeError('Suffix limit must be a non-negative safe integer')
    }
    if (this.length <= maxBytes) {
      return
    }
    this.start += this.length - maxBytes
    this.length = maxBytes
    if (this.length === 0) {
      this.start = 0
    }
  }

  toString(encoding: BufferEncoding = 'utf8'): string {
    return this.storage.toString(encoding, this.start, this.start + this.length)
  }

  takeString(encoding: BufferEncoding = 'utf8'): string {
    const value = this.toString(encoding)
    this.clear()
    return value
  }

  // Returns a view over the released storage, not a copy; the buffer never writes to it again.
  takeBuffer(): Buffer {
    const value = this.storage.subarray(this.start, this.start + this.length)
    this.clear()
    return value
  }

  clear(): void {
    this.storage = Buffer.alloc(0)
    this.start = 0
    this.length = 0
  }

  private reclaimHeadRoom(required: number): void {
    // Slide the live bytes down while they fit in half the storage; only grow when they do not.
    if (required * 2 <= this.storage.byteLength) {
      this.storage.copy(this.storage, 0, this.start, this.start + this.length)
    } else {
      const capacity = Math.max(required, Math.max(256, this.storage.byteLength * 2))
      const next = Buffer.allocUnsafe(capacity)
      this.storage.copy(next, 0, this.start, this.start + this.length)
      this.storage = next
    }
    this.start = 0
  }
}
