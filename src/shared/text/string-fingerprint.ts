// Compact 64-bit + length fingerprint for opaque in-memory cache/change keys (avoids retaining multi-KB JSON strings).

const FNV_OFFSET_A = 0x811c_9dc5
const FNV_PRIME_A = 0x0100_0193
const FNV_OFFSET_B = 0x9e37_79b1
const FNV_PRIME_B = 0x85eb_ca6b

function mixCodeUnit(h: number, unit: number, prime: number): number {
  return Math.imul(h ^ unit, prime) >>> 0
}

export function fingerprintString(value: string): string {
  let h1 = FNV_OFFSET_A
  let h2 = FNV_OFFSET_B
  for (let i = 0; i < value.length; i += 1) {
    const unit = value.charCodeAt(i)
    h1 = mixCodeUnit(h1, unit, FNV_PRIME_A)
    h2 = mixCodeUnit(h2, unit ^ (i & 0xff), FNV_PRIME_B)
  }
  return `${value.length}:${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`
}

export type StringListFingerprinter = {
  push: (item: string) => void
  digest: () => string
}

/** Incremental counterpart to `fingerprintStringList`, avoiding an intermediate string array. */
export function createStringListFingerprinter(): StringListFingerprinter {
  // Store 32-bit unsigned hashes in a typed array and mix in locals so V8 never boxes HeapNumbers into closure slots.
  const hashes = new Uint32Array(2)
  hashes[0] = FNV_OFFSET_A
  hashes[1] = FNV_OFFSET_B
  let count = 0
  let totalChars = 0
  return {
    push(item: string): void {
      const i = count
      count += 1
      totalChars += item.length
      let h1 = mixCodeUnit(hashes[0], item.length, FNV_PRIME_A)
      let h2 = mixCodeUnit(hashes[1], item.length ^ i, FNV_PRIME_B)
      for (let j = 0; j < item.length; j += 1) {
        const unit = item.charCodeAt(j)
        h1 = mixCodeUnit(h1, unit, FNV_PRIME_A)
        h2 = mixCodeUnit(h2, unit ^ (j & 0xff), FNV_PRIME_B)
      }
      // Delimiter sentinel prevents ["ab","c"] colliding with ["a","bc"].
      hashes[0] = mixCodeUnit(h1, 0xfffe, FNV_PRIME_A)
      hashes[1] = mixCodeUnit(h2, 0xffff, FNV_PRIME_B)
    },
    digest(): string {
      return `${count}:${totalChars}:${hashes[0].toString(16).padStart(8, '0')}${hashes[1].toString(16).padStart(8, '0')}`
    }
  }
}

export function fingerprintStringList(values: readonly string[]): string {
  const fingerprinter = createStringListFingerprinter()
  for (let i = 0; i < values.length; i += 1) {
    fingerprinter.push(values[i])
  }
  return fingerprinter.digest()
}
