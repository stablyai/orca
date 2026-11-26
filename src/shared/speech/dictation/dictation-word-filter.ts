/**
 * A Bloom filter over lowercase a-z words: about 1 byte a word instead of the word, so a ~90k-word list fits
 * in a phone's page bundle. A false "yes" (~2%) only makes dictation leave a word alone.
 */
export type WordFilter = { bits: number; hashes: number; base64: string }

// Double hashing over two FNV-1a variants; the generator and the reader must agree on this.
export function wordFilterSlots(word: string, bits: number, hashes: number): number[] {
  let first = 0x811c9dc5
  let second = 0x01000193
  for (let index = 0; index < word.length; index++) {
    const code = word.charCodeAt(index)
    first = Math.imul(first ^ code, 0x01000193)
    second = Math.imul(second ^ code, 0x5bd1e995) ^ (second >>> 15)
  }
  const step = (second | 1) >>> 0
  const slots: number[] = []
  for (let index = 0; index < hashes; index++) {
    slots.push(((first >>> 0) + index * step) % bits)
  }
  return slots
}

/** Whether `word` may be in the filter: false is certain, true is right ~98% of the time. */
export function createWordFilterLookup(filter: WordFilter): (word: string) => boolean {
  const bytes = Uint8Array.from(atob(filter.base64), (char) => char.charCodeAt(0))
  return (word) =>
    wordFilterSlots(word, filter.bits, filter.hashes).every(
      (slot) => (bytes[slot >>> 3] & (1 << (slot & 7))) !== 0
    )
}
