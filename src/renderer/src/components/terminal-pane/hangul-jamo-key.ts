/** Accept hardware conjoining, compatibility, extended and halfwidth jamo, including Shift doubles in the compatibility block. */
const HANGUL_JAMO_KEY = /^[ᄀ-ᇿ㄰-㆏ꥠ-꥿ힰ-퟿ﾠ-ￜ]$/

export function isHangulJamoKeyText(key: string): boolean {
  return HANGUL_JAMO_KEY.test(key)
}
