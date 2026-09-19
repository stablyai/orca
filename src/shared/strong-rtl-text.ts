/** Every strong-RTL block sits at/above U+0590, so ASCII/Latin bails out with a single charCodeAt sweep. */
export const RTL_SCAN_FLOOR = 0x0590

export function isStrongRtlCodePoint(codePoint: number): boolean {
  return (
    // One contiguous strong-RTL span (Hebrew through Arabic Extended-A).
    (codePoint >= 0x0590 && codePoint <= 0x08ff) ||
    // Hebrew + Arabic presentation forms (legacy shaped codepoints).
    (codePoint >= 0xfb1d && codePoint <= 0xfdff) ||
    (codePoint >= 0xfe70 && codePoint <= 0xfeff) ||
    // Historic RTL scripts (Phoenician, Nabataean, …).
    (codePoint >= 0x10800 && codePoint <= 0x10fff) ||
    // Mende Kikakui, Adlam, Arabic Mathematical symbols.
    (codePoint >= 0x1e800 && codePoint <= 0x1eeff)
  )
}

export function containsStrongRtlText(text: string): boolean {
  for (let index = 0; index < text.length; index++) {
    const unit = text.charCodeAt(index)
    if (unit < RTL_SCAN_FLOOR) {
      continue
    }
    let codePoint = unit
    if (unit >= 0xd800 && unit <= 0xdbff && index + 1 < text.length) {
      const low = text.charCodeAt(index + 1)
      if (low >= 0xdc00 && low <= 0xdfff) {
        codePoint = (unit - 0xd800) * 0x400 + (low - 0xdc00) + 0x10000
        index++
      }
    }
    if (isStrongRtlCodePoint(codePoint)) {
      return true
    }
  }
  return false
}
