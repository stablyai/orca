// Untrusted skill and plugin names/descriptions are shown in the picker and the
// Settings skill list. Control, C1, zero-width, and bidi-override codepoints can
// spoof a row or hide characters, so both the main-process label builder and the
// renderer picker strip them through this one predicate rather than maintaining
// divergent copies.
export function isSafeDisplayCharacter(character: string): boolean {
  const code = character.codePointAt(0) ?? 0
  return !(
    code <= 0x1f ||
    (code >= 0x7f && code <= 0x9f) ||
    code === 0x200b ||
    code === 0x200e ||
    code === 0x200f ||
    code === 0x061c ||
    code === 0x2060 ||
    code === 0xfeff ||
    code === 0x2028 ||
    code === 0x2029 ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  )
}

export function stripUnsafeDisplayCharacters(value: string): string {
  return [...value].filter(isSafeDisplayCharacter).join('')
}
