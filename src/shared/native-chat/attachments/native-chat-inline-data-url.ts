/** Inline image bytes; stay local and out of RPC frames and text exports. */
export function isInlineDataUrl(value: string): boolean {
  let schemeStart = 0
  while (schemeStart < value.length && value.charCodeAt(schemeStart) <= 0x20) {
    schemeStart += 1
  }
  return /^data:/i.test(value.slice(schemeStart))
}
