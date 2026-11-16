// Controls, format characters (bidi overrides, zero-width, tags) and line separators can reorder or
// hide text, so host labels and renderer pickers strip them with this one predicate.
const UNSAFE_DISPLAY_CHARACTER = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u
// ZWNJ and ZWJ are format characters that Persian, Indic scripts and emoji sequences need.
const SAFE_JOINERS = new Set(['\u200c', '\u200d'])

export function isSafeDisplayCharacter(character: string): boolean {
  return SAFE_JOINERS.has(character) || !UNSAFE_DISPLAY_CHARACTER.test(character)
}

export function stripUnsafeDisplayCharacters(value: string): string {
  return [...value].filter(isSafeDisplayCharacter).join('')
}
