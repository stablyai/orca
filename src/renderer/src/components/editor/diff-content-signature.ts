// Why: Monaco diff tabs keep models alive via keepCurrent*Model. Rotating model
// identities when git-fetched blob content changes forces a fresh paint without
// remounting on every editable keystroke.
export function getDiffContentSignature(content: string): string {
  let hash = 2166136261
  for (let i = 0; i < content.length; i += 1) {
    hash ^= content.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16)
}

// Why: the disk baseline guards against silently overwriting external writes
// (issue #7265), where a hash collision means a missed conflict — so it gets
// two independent FNV lanes plus the length instead of the single 32-bit lane
// that suffices for cosmetic model rotation above.
export function getDiskBaselineSignature(content: string): string {
  let hashA = 2166136261
  let hashB = 84696351
  for (let i = 0; i < content.length; i += 1) {
    const code = content.charCodeAt(i)
    hashA ^= code
    hashA = Math.imul(hashA, 16777619)
    hashB = Math.imul(hashB ^ code, 1099511627)
  }
  return `${(hashA >>> 0).toString(16)}-${(hashB >>> 0).toString(16)}-${content.length.toString(16)}`
}
