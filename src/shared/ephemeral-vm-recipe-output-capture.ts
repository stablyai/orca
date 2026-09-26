// Receives complete decoded characters from the child stream's UTF-8 decoder.
export class RecipeOutputCapture {
  private storage = Buffer.alloc(0)
  private start = 0
  private length = 0
  private unusualLimitText = ''

  constructor(private readonly maxBytes: number) {}

  append(chunk: string): void {
    if (this.maxBytes <= 0) {
      return
    }
    // Preserve the historical coercion behavior for fractional and non-finite limits.
    if (!Number.isSafeInteger(this.maxBytes)) {
      const chunkBytes = Buffer.byteLength(chunk, 'utf8')
      this.unusualLimitText =
        chunkBytes >= this.maxBytes
          ? utf8Tail(chunk, this.maxBytes)
          : utf8Tail(this.unusualLimitText, this.maxBytes - chunkBytes) + chunk
      return
    }
    const bytes = Buffer.from(chunk, 'utf8')
    if (bytes.length >= this.maxBytes) {
      let start = bytes.length - this.maxBytes
      while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) {
        start += 1
      }
      this.storage = Buffer.from(bytes.subarray(start))
      this.start = 0
      this.length = this.storage.length
      return
    }
    const discard = Math.max(0, this.length + bytes.length - this.maxBytes)
    if (discard > 0) {
      this.start = (this.start + discard) % this.storage.length
      this.length -= discard
      while (this.length > 0 && (this.storage[this.start]! & 0xc0) === 0x80) {
        this.start = (this.start + 1) % this.storage.length
        this.length -= 1
      }
    }
    const required = this.length + bytes.length
    if (required > this.storage.length) {
      const capacity = Math.min(this.maxBytes, Math.max(required, 256, this.storage.length * 2))
      const next = Buffer.allocUnsafe(capacity)
      const firstLength = Math.min(this.length, this.storage.length - this.start)
      this.storage.copy(next, 0, this.start, this.start + firstLength)
      this.storage.copy(next, firstLength, 0, this.length - firstLength)
      this.storage = next
      this.start = 0
    }
    if (bytes.length > 0) {
      const end = (this.start + this.length) % this.storage.length
      const firstLength = Math.min(bytes.length, this.storage.length - end)
      bytes.copy(this.storage, end, 0, firstLength)
      bytes.copy(this.storage, 0, firstLength)
      this.length += bytes.length
    }
  }

  takeText(): string {
    let text = this.unusualLimitText
    if (Number.isSafeInteger(this.maxBytes) && this.maxBytes > 0) {
      const end = this.start + this.length
      text =
        end <= this.storage.length
          ? this.storage.toString('utf8', this.start, end)
          : Buffer.concat(
              [
                this.storage.subarray(this.start),
                this.storage.subarray(0, end - this.storage.length)
              ],
              this.length
            ).toString('utf8')
    }
    this.clear()
    return text
  }

  clear(): void {
    this.storage = Buffer.alloc(0)
    this.start = 0
    this.length = 0
    this.unusualLimitText = ''
  }
}

function utf8Tail(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, 'utf8')
  if (bytes.byteLength <= maxBytes) {
    return value
  }
  let start = bytes.byteLength - maxBytes
  while (start < bytes.byteLength && (bytes[start]! & 0xc0) === 0x80) {
    start += 1
  }
  return bytes.subarray(start).toString('utf8')
}
