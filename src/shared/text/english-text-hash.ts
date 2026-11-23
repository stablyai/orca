/** FNV-1a over English copy: a catalog key suffix desktop and phone derive alike, without a crypto API. */
export function englishTextHash(english: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < english.length; index += 1) {
    hash ^= english.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}
