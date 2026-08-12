export class GrowingByteBuffer {
  private storage = Buffer.alloc(0)
  private length = 0

  get byteLength(): number {
    return this.length
  }

  append(bytes: Buffer | Uint8Array): void {
    if (bytes.byteLength === 0) {
      return
    }
    const required = this.length + bytes.byteLength
    if (required > this.storage.byteLength) {
      const capacity = Math.max(required, Math.max(256, this.storage.byteLength * 2))
      const next = Buffer.allocUnsafe(capacity)
      this.storage.copy(next, 0, 0, this.length)
      this.storage = next
    }
    const source = Buffer.isBuffer(bytes)
      ? bytes
      : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    source.copy(this.storage, this.length)
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
      this.length = maxBytes
      return
    }
    const retainedBytes = Math.min(this.length, maxBytes - source.byteLength)
    if (retainedBytes < this.length) {
      this.storage.copy(this.storage, 0, this.length - retainedBytes, this.length)
      this.length = retainedBytes
    }
    this.append(source)
  }

  indexOfByte(value: number, byteOffset = 0): number {
    return this.storage.subarray(0, this.length).indexOf(value, byteOffset)
  }

  takePrefixString(byteLength: number, encoding: BufferEncoding = 'utf8'): string {
    if (!Number.isSafeInteger(byteLength) || byteLength < 0 || byteLength > this.length) {
      throw new RangeError('Prefix length exceeds retained bytes')
    }
    const value = this.storage.toString(encoding, 0, byteLength)
    this.discardPrefix(byteLength)
    return value
  }

  discardPrefix(byteLength: number): void {
    if (!Number.isSafeInteger(byteLength) || byteLength < 0 || byteLength > this.length) {
      throw new RangeError('Prefix length exceeds retained bytes')
    }
    if (byteLength === 0) {
      return
    }
    this.storage.copy(this.storage, 0, byteLength, this.length)
    this.length -= byteLength
  }

  retainSuffix(maxBytes: number): void {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
      throw new RangeError('Suffix limit must be a non-negative safe integer')
    }
    if (this.length <= maxBytes) {
      return
    }
    this.storage.copy(this.storage, 0, this.length - maxBytes, this.length)
    this.length = maxBytes
  }

  toString(encoding: BufferEncoding = 'utf8'): string {
    return this.storage.toString(encoding, 0, this.length)
  }

  takeString(encoding: BufferEncoding = 'utf8'): string {
    const value = this.toString(encoding)
    this.clear()
    return value
  }

  clear(): void {
    this.storage = Buffer.alloc(0)
    this.length = 0
  }
}
