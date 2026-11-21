// Controls, format characters (bidi overrides, zero-width, tags) and line separators can reorder or
// hide text, so host labels and renderer pickers check and strip them with this one pattern. ZWNJ
// and ZWJ stay: Persian, Indic scripts and emoji sequences need them.
const UNSAFE_DISPLAY_CHARACTER = /(?![\u200c\u200d])[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u
const UNSAFE_DISPLAY_CHARACTERS = new RegExp(UNSAFE_DISPLAY_CHARACTER.source, 'gu')

export function isSafeDisplayText(value: string): boolean {
  return !UNSAFE_DISPLAY_CHARACTER.test(value)
}

export function stripUnsafeDisplayCharacters(value: string): string {
  return value.replace(UNSAFE_DISPLAY_CHARACTERS, '')
}
