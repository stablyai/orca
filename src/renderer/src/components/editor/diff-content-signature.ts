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
