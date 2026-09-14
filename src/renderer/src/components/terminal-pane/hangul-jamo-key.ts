/** Jamo a hardware keyboard reports directly in `KeyboardEvent.key`: conjoining,
 *  compatibility, extended and halfwidth forms. Shift-typed doubles (ㄲ ㄸ ㅃ ㅆ ㅉ)
 *  live in the compatibility block alongside the singles. */
const HANGUL_JAMO_KEY = /^[ᄀ-ᇿ㄰-㆏ꥠ-꥿ힰ-퟿ﾠ-ￜ]$/

/** Returns whether `key` is a single Hangul jamo. */
export function isHangulJamoKeyText(key: string): boolean {
  return HANGUL_JAMO_KEY.test(key)
}
